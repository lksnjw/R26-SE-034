"""
Policy fixture generator — front-matter parsing + clause-aware chunking.

SCOPE NOTE: production policy ingestion is owned by the data-transport layer,
not by this module. This file serves two narrower purposes:

  1. A reference implementation of the chunking behaviour required by
     `docs/POLICY_PAYLOAD_CONTRACT.md` §4 — portable to their pipeline.
  2. An offline fixture source, so the decision engine can be developed and
     tested without depending on their collection being populated or reachable.

Why the general splitter is unusable for policy text:

The general ingester splits at CHUNK_SIZE=500 on character boundaries.  Applied
to a rule like

    "Outbound transfers exceeding 25,000 require dual authorization."

that can produce  "...transfers exceeding 25,000 require"  and  "dual
authorization."  as two separate chunks.  Neither is a retrievable rule — the
threshold survives without its consequence, and the judge approves an action it
should have blocked.

So policy documents are split on *clause* boundaries first (headings, numbered
items, blank lines) and only hard-split when a single clause exceeds the limit.
"""
import logging
import os
import re

# pyrefly: ignore [missing-import]
import yaml
from langchain_core.documents import Document as LCDocument

from src.config.settings import settings
from src.types.policy import PolicyMeta

logger = logging.getLogger(__name__)

_FRONT_MATTER = re.compile(r"\A---\s*\n(.*?)\n---\s*\n", re.DOTALL)

# A new clause starts at: markdown heading, "1." / "1.2" numbering,
# "Section 4", or a lettered "(a)" item — all at line start.
_CLAUSE_START = re.compile(
    r"^(?:#{1,6}\s+"           # markdown heading
    r"|\d+(?:\.\d+)*[.)]\s+"   # 1.  1.2.  3)
    r"|\(?[a-z]\)\s+"          # (a)  b)
    r"|Section\s+\d+"          # Section 4
    r"|Article\s+\d+"          # Article 12
    r")",
    re.MULTILINE | re.IGNORECASE,
)

# A clause that opens a new numbered section: "## 2. Segregation of duties".
_SECTION_HEADING = re.compile(r"\A#{1,6}\s*(\d+(?:\.\d+)*)[.)]?\s+")

# Any clause reference at the start of a line: "2.4 ...", "## 3. ...".
_CLAUSE_REF = re.compile(r"^(?:#{1,6}\s*)?(\d+(?:\.\d+)*)[.)]?\s+", re.MULTILINE)


def sections_in(chunk: str) -> set[str]:
    """
    Every clause reference the chunk contains, plus the sections they belong to.

    "2.1" implies section "2", so a tag authored against §2 resolves whether the
    document numbers its clauses or only its headings.
    """
    refs: set[str] = set()
    for match in _CLAUSE_REF.finditer(chunk):
        ref = match.group(1)
        refs.add(ref)
        refs.add(ref.split(".")[0])
    return refs


def parse_front_matter(text: str) -> tuple[PolicyMeta, str]:
    """
    Split a policy document into its YAML front-matter and body.

    Raises ValueError if front-matter is missing or lacks `policy_id` — an
    untagged policy cannot be filtered on, so it must not silently ingest.
    """
    match = _FRONT_MATTER.match(text)
    if not match:
        raise ValueError(
            "policy document has no YAML front-matter block (expected '---' delimited header)"
        )

    raw = yaml.safe_load(match.group(1)) or {}
    if not isinstance(raw, dict):
        raise ValueError("front-matter must be a YAML mapping")
    if not raw.get("policy_id"):
        raise ValueError("front-matter is missing required field 'policy_id'")

    # YAML parses unquoted dates into date objects; payload needs strings.
    if raw.get("effective_date") is not None:
        raw["effective_date"] = str(raw["effective_date"])
    if raw.get("version") is not None:
        raw["version"] = str(raw["version"])

    body = text[match.end():].strip()
    return PolicyMeta(**raw), body


def split_clauses(body: str) -> list[str]:
    """Break the body at clause starts, keeping each clause's text contiguous."""
    boundaries = [m.start() for m in _CLAUSE_START.finditer(body)]
    if not boundaries:
        # No structural markers — fall back to paragraphs.
        return [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]

    if boundaries[0] != 0:
        boundaries.insert(0, 0)   # preamble before the first marker
    boundaries.append(len(body))

    clauses = []
    for start, end in zip(boundaries, boundaries[1:]):
        clause = body[start:end].strip()
        if clause:
            clauses.append(clause)
    return clauses


def _hard_split(clause: str, limit: int) -> list[str]:
    """Last resort for an oversized clause — split on sentence ends, never mid-sentence."""
    sentences = re.split(r"(?<=[.;:])\s+", clause)
    parts: list[str] = []
    current = ""
    for sentence in sentences:
        if current and len(current) + len(sentence) + 1 > limit:
            parts.append(current.strip())
            current = sentence
        else:
            current = f"{current} {sentence}".strip()
    if current.strip():
        parts.append(current.strip())
    return parts


def pack_clauses(clauses: list[str], limit: int) -> list[str]:
    """
    Merge adjacent clauses up to `limit` so chunks aren't uselessly small,
    without ever letting a single clause straddle two chunks.

    A numbered section heading always starts a new chunk, even when the previous
    chunk has room. Merging across one produces a chunk whose recorded `section`
    names only its first heading: §1+§2 merged is cited as "#1", so a denial
    resting on §2 points the requester at §1 and quotes §1's text alongside it.
    Packing tighter is not worth a citation that misdescribes itself.
    """
    chunks: list[str] = []
    current = ""

    for clause in clauses:
        starts_section = bool(_SECTION_HEADING.match(clause))

        if len(clause) > limit:
            if current:
                chunks.append(current)
                current = ""
            chunks.extend(_hard_split(clause, limit))
            continue

        candidate = f"{current}\n\n{clause}".strip() if current else clause
        if current and (starts_section or len(candidate) > limit):
            chunks.append(current)
            current = clause
        else:
            current = candidate

    if current:
        chunks.append(current)
    return chunks


def build_policy_documents(text: str, source: str) -> list[LCDocument]:
    """
    Turn one raw policy document into tagged, clause-aligned LangChain Documents.

    Every chunk carries the full front-matter payload, so Qdrant can filter on
    `applies_to_tools` / `mandatory` / `risk_level` without relying on the
    embedding to have ranked the right rule into the top-k.
    """
    meta, body = parse_front_matter(text)
    chunks = pack_clauses(split_clauses(body), settings.POLICY_CHUNK_SIZE)

    base_payload = meta.to_payload()
    wanted = meta.enforced_sections

    docs = []
    for i, chunk in enumerate(chunks):
        present = sections_in(chunk)
        # Narrow `enforces` to the chunk that actually states each check. A check
        # authored without a section stays on every chunk — the caller told us
        # the document is the authority and we do not guess a clause for it.
        payload = {
            **base_payload,
            "enforces": [
                check
                for check, section in wanted.items()
                if section is None or section in present
            ],
            "source": source,
            "chunk_index": i,
        }
        docs.append(LCDocument(page_content=chunk, metadata=payload))

    orphaned = [
        check
        for check, section in wanted.items()
        if section is not None
        and not any(section in sections_in(c) for c in chunks)
    ]
    if orphaned:
        # The tag names a clause this document does not contain — a typo, or a
        # section that was renumbered. Silently it means the check has no
        # authority at all and every denial it raises cites nothing.
        logger.error(
            f"policy '{meta.policy_id}': enforces tag(s) {orphaned} name a section "
            f"that is not in the document — the check would be unattributable"
        )

    logger.info(
        f"policy '{meta.policy_id}' v{meta.version} → {len(docs)} chunk(s) "
        f"| actions={meta.applies_to_actions} | mandatory={meta.mandatory}"
    )
    return docs


def build_policy_documents_from_file(path: str) -> list[LCDocument]:
    """Read a policy file and build its tagged Documents. `source` is the basename."""
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    return build_policy_documents(text, source=os.path.basename(path))

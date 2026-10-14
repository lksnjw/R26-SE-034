"""
Seed a Qdrant instance with the local policy corpus.

WHY
    The production Qdrant and its policy corpus are owned by the data-transport
    layer and are not available yet. This script builds a stand-in that follows
    `docs/POLICY_PAYLOAD_CONTRACT.md` exactly, so the decision engine can be
    built and tested now against the shape we asked for. When their collection
    arrives, point RETRIEVER/QDRANT_URL at it and delete nothing but this data.

WHAT IT CREATES
    POLICY_COLLECTION  ← src/data/documents/policies/     (doc_type: policy | privacy_policy)
    QDRANT_COLLECTION  ← src/data/documents/company_data/ (doc_type: company_data)

    Two collections, per contract §6. Company data is seeded deliberately: a
    filter bug that lets an employee record be read as governing authority is
    only observable if such a record exists to leak.

PREREQUISITES (both must be running — there is no offline mode)
    docker compose -f docker/docker-compose.yml up -d
    ollama pull nomic-embed-text

RUN (from the rag-system directory)
    .venv/Scripts/python.exe -m scripts.seed_qdrant_policies
    .venv/Scripts/python.exe -m scripts.seed_qdrant_policies --recreate

IDEMPOTENT
    Point ids are derived from policy_id + version + chunk index, so re-running
    overwrites in place instead of duplicating. Editing a policy without bumping
    its version therefore updates the existing points — intended, since these are
    fixtures. Use --recreate after deleting or renaming a document.
"""
import argparse
import logging
import os
import re
import sys
import uuid

from langchain_core.documents import Document as LCDocument
from qdrant_client.http import models as qm

from src.config.qdrant_client import get_qdrant_client
from src.config.settings import settings
from src.core.actions.action_registry import REGISTRY_VERSION, action_names
from src.core.embeddings.embedding_service import get_embeddings
from src.core.policy.policy_ingest import build_policy_documents_from_file

logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(name)s | %(message)s")
logger = logging.getLogger("seed")

_DOCS_ROOT = os.path.join(os.path.dirname(__file__), "..", "src", "data", "documents")
POLICY_DIR = os.path.abspath(os.path.join(_DOCS_ROOT, "policies"))
COMPANY_DATA_DIR = os.path.abspath(os.path.join(_DOCS_ROOT, "company_data"))

# Stable across machines and runs, so the same document always yields the same
# point ids — that is what makes re-seeding an update rather than a duplication.
_NAMESPACE = uuid.UUID("6f9619ff-8b86-d011-b42d-00c04fc964ff")

# Leading clause reference of a chunk: "2.4 ...", "## 3. ...", "(a) ...".
_SECTION_REF = re.compile(r"^(?:#{1,6}\s*)?(\d+(?:\.\d+)*)[.)]?\s+")

_KNOWN_ACTIONS = set(action_names())

# Payload fields the retrieval layer filters on. Without indexes these still
# work but degrade to a full scan once the corpus is real-sized.
_INDEXES: dict[str, qm.PayloadSchemaType] = {
    "metadata.doc_type": qm.PayloadSchemaType.KEYWORD,
    "metadata.policy_id": qm.PayloadSchemaType.KEYWORD,
    "metadata.applies_to_actions": qm.PayloadSchemaType.KEYWORD,
    "metadata.risk_level": qm.PayloadSchemaType.KEYWORD,
    "metadata.version": qm.PayloadSchemaType.KEYWORD,
    "metadata.mandatory": qm.PayloadSchemaType.BOOL,
    "metadata.is_current": qm.PayloadSchemaType.BOOL,
    "metadata.threshold_value": qm.PayloadSchemaType.FLOAT,
}


# ── Loading ──────────────────────────────────────────────────────────────────


def _section_of(chunk: str, fallback: str | None) -> str | None:
    """
    Clause reference for this chunk, so a denial can cite '2.4' not just the doc.

    Front-matter carries at most one `section` for the whole document; the real
    reference varies per chunk, and a citation that points at the wrong clause is
    worse than one that points at the document.
    """
    first_line = chunk.lstrip().split("\n", 1)[0]
    match = _SECTION_REF.match(first_line)
    return match.group(1) if match else fallback


def load_documents(directory: str) -> list[LCDocument]:
    """Parse and clause-chunk every markdown document in `directory`."""
    if not os.path.isdir(directory):
        logger.warning(f"no such directory, skipping: {directory}")
        return []

    docs: list[LCDocument] = []
    for filename in sorted(os.listdir(directory)):
        if not filename.endswith((".md", ".txt")):
            continue
        path = os.path.join(directory, filename)
        try:
            file_docs = build_policy_documents_from_file(path)
        except ValueError as exc:
            # A document that cannot be tagged cannot be filtered on, so it must
            # not be seeded silently as if it were governing.
            logger.error(f"SKIPPED {filename}: {exc}")
            continue

        for doc in file_docs:
            doc.metadata["section"] = _section_of(
                doc.page_content, doc.metadata.get("section")
            )
            # Recorded so a collection embedded with one model is detectable if the
            # model is ever changed — mixed vector spaces produce meaningless scores.
            doc.metadata["embedding_model"] = settings.EMBED_MODEL
        docs.extend(file_docs)

    return docs


def validate(docs: list[LCDocument]) -> list[str]:
    """
    Contract checks that must hold before anything is written.

    An action tag typo produces no error at query time — the rule just stops
    being retrieved. Catching it here is the only cheap place.
    """
    problems: list[str] = []
    for doc in docs:
        meta = doc.metadata
        pid = meta.get("policy_id", "<none>")

        for action in meta.get("applies_to_actions") or []:
            if action not in _KNOWN_ACTIONS:
                problems.append(
                    f"{pid}: unregistered action '{action}' "
                    f"(registry v{REGISTRY_VERSION}) — this rule would never be retrieved"
                )

        if not meta.get("applies_to_actions") and not meta.get("mandatory"):
            if meta.get("doc_type") not in ("company_data",):
                problems.append(
                    f"{pid}: governs no action and is not mandatory — unreachable by "
                    f"action-filtered retrieval"
                )

    # Every code-enforced check must land on exactly one chunk. Zero means a
    # denial by that check can cite nothing; more than one means the engine picks
    # by retrieval order again, which is the bug the section tag exists to fix.
    tagged: dict[tuple[str, str], int] = {}
    for doc in docs:
        pid = doc.metadata.get("policy_id", "<none>")
        for check in doc.metadata.get("enforces") or []:
            tagged[(pid, check)] = tagged.get((pid, check), 0) + 1

    for (pid, check), count in sorted(tagged.items()):
        if count != 1:
            problems.append(
                f"{pid}: check '{check}' is tagged on {count} chunks — a denial by it "
                f"would cite whichever chunk retrieval returned first; give the "
                f"`enforces` entry the clause number that states the rule"
            )
    return problems


# ── Writing ──────────────────────────────────────────────────────────────────


def ensure_collection(client, name: str, recreate: bool) -> None:
    existing = {c.name for c in client.get_collections().collections}

    if recreate and name in existing:
        client.delete_collection(name)
        existing.discard(name)
        logger.info(f"dropped collection '{name}'")

    if name not in existing:
        client.create_collection(
            collection_name=name,
            # Unnamed vector + Cosine + EMBED_DIMENSION: contract §5, and what
            # langchain_qdrant's default vector_name='' expects.
            vectors_config=qm.VectorParams(
                size=settings.EMBED_DIMENSION,
                distance=qm.Distance.COSINE,
            ),
        )
        logger.info(f"created collection '{name}' (dim={settings.EMBED_DIMENSION}, cosine)")
    else:
        logger.info(f"using existing collection '{name}'")

    for field, schema in _INDEXES.items():
        try:
            client.create_payload_index(
                collection_name=name, field_name=field, field_schema=schema
            )
        except Exception as exc:  # noqa: BLE001 - index support varies by mode
            # Local mode filters without indexes; on a server this is worth seeing.
            logger.debug(f"payload index {field} on '{name}': {exc}")


def build_points(docs: list[LCDocument]) -> list[qm.PointStruct]:
    """
    Embed every chunk and build its point.

    Kept separate from writing, and called BEFORE the collection is touched:
    embedding is the step that reaches out to Ollama and so the step that fails.
    Dropping the collection first and discovering the embedder is down afterwards
    leaves an empty collection — and an empty policy collection is a gate that
    retrieves no rules at all. (Observed twice; not hypothetical.)
    """
    embeddings = get_embeddings()
    vectors = embeddings.embed_documents([d.page_content for d in docs])

    points = []
    for doc, vector in zip(docs, vectors):
        meta = doc.metadata
        key = f"{meta['policy_id']}|{meta.get('version')}|{meta.get('chunk_index')}"
        points.append(
            qm.PointStruct(
                id=str(uuid.uuid5(_NAMESPACE, key)),
                vector=vector,
                # Nested under "metadata" to match langchain_qdrant's default
                # layout; payload_adapter.flatten() reads flat or nested.
                payload={"page_content": doc.page_content, "metadata": meta},
            )
        )

    return points


# ── Report ───────────────────────────────────────────────────────────────────


def report(docs: list[LCDocument], collection: str) -> None:
    by_policy: dict[str, list[LCDocument]] = {}
    for doc in docs:
        by_policy.setdefault(doc.metadata["policy_id"], []).append(doc)

    print(f"\n  {collection}")
    for pid, chunks in sorted(by_policy.items()):
        meta = chunks[0].metadata
        flags = []
        if meta.get("mandatory"):
            flags.append("MANDATORY")
        if not meta.get("is_current", True):
            flags.append("SUPERSEDED")
        actions = ",".join(meta.get("applies_to_actions") or []) or "-"
        print(
            f"    {pid}@{meta.get('version'):<5} {len(chunks):>2} chunks  "
            f"{meta.get('doc_type'):<14} {actions}"
            + (f"  [{' '.join(flags)}]" if flags else "")
        )

    coverage = {a: 0 for a in sorted(_KNOWN_ACTIONS)}
    mandatory = 0
    for doc in docs:
        if doc.metadata.get("mandatory"):
            mandatory += 1
        for action in doc.metadata.get("applies_to_actions") or []:
            if action in coverage:
                coverage[action] += 1

    if any(coverage.values()) or mandatory:
        print(f"\n  action coverage (chunks per registered action, registry v{REGISTRY_VERSION})")
        for action, count in coverage.items():
            marker = "" if count else "   <- NO POLICY"
            print(f"    {action:<22} {count:>3}{marker}")
        print(f"    {'(mandatory, all actions)':<22} {mandatory:>3}")


# ── Entry point ──────────────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--recreate", action="store_true",
        help="drop and rebuild both collections instead of upserting in place",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="parse, chunk and validate without touching Qdrant",
    )
    args = parser.parse_args()

    print("=" * 72)
    print(f"embedding model   : {settings.EMBED_MODEL} (dim {settings.EMBED_DIMENSION})")
    print(f"qdrant            : {settings.QDRANT_URL}")
    print(f"policy collection : {settings.POLICY_COLLECTION}")
    print(f"data collection   : {settings.QDRANT_COLLECTION}")
    print("=" * 72)

    policy_docs = load_documents(POLICY_DIR)
    data_docs = load_documents(COMPANY_DATA_DIR)

    problems = validate(policy_docs + data_docs)
    if problems:
        print("\nCONTRACT VIOLATIONS — nothing was written:")
        for problem in problems:
            print(f"  - {problem}")
        return 1

    report(policy_docs, settings.POLICY_COLLECTION)
    report(data_docs, settings.QDRANT_COLLECTION)

    if args.dry_run:
        print("\ndry run - Qdrant untouched")
        return 0

    client = get_qdrant_client()

    # Embed everything first. Nothing in Qdrant is touched until every vector for
    # every collection exists, so a failure here leaves the current corpus serving.
    prepared = [
        (collection, build_points(docs))
        for collection, docs in (
            (settings.POLICY_COLLECTION, policy_docs),
            (settings.QDRANT_COLLECTION, data_docs),
        )
        if docs
    ]

    written = 0
    for collection, points in prepared:
        ensure_collection(client, collection, args.recreate)
        client.upsert(collection_name=collection, points=points, wait=True)
        count = len(points)
        written += count
        total = client.get_collection(collection).points_count
        print(f"\n  upserted {count} points into '{collection}' (now {total} total)")

    print(f"\nseeded {written} points.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

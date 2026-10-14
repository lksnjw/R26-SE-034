"""
Offline proof that clause-aware chunking preserves rules the general ingester breaks.

No network, no Ollama, no Qdrant — pure text processing.

Run from the rag-system directory:
    .venv/Scripts/python.exe -m scripts.verify_policy_chunking
"""
import os

from langchain_text_splitters import RecursiveCharacterTextSplitter

from src.config.settings import settings
from src.core.policy.policy_ingest import (
    build_policy_documents_from_file,
    parse_front_matter,
)

POLICY_FILE = os.path.join(
    os.path.dirname(__file__), "..", "src", "data", "documents",
    "policies", "FIN-VND-2026-004-vendor-bank-details.md",
)

# Clause 3.2 — a single-paragraph clause longer than CHUNK_SIZE, which is where
# character-window splitting actually severs a rule from its own exception.
# The threshold ("two working days") and the exception that permits same-day
# effect are ~700 characters apart inside one sentence.
CLAUSE = "3.2"
THRESHOLD = "two working days"
CONSEQUENCE = "same-day effect is permitted"


def _general_splitter_chunks(body: str) -> list[str]:
    """What the existing ingest_service.py would produce for this document."""
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=settings.CHUNK_SIZE,
        chunk_overlap=settings.CHUNK_OVERLAP,
        separators=["\n\n", "\n", ". ", " ", ""],
        length_function=len,
    )
    return [d.page_content for d in splitter.create_documents([body])]


def _intact(chunks: list[str]) -> int:
    """How many chunks contain the threshold and its consequence together."""
    return sum(1 for c in chunks if THRESHOLD in c and CONSEQUENCE in c)


def main() -> None:
    path = os.path.abspath(POLICY_FILE)
    with open(path, encoding="utf-8") as fh:
        raw = fh.read()

    meta, body = parse_front_matter(raw)
    print("=" * 68)
    print("front-matter parsed")
    print(f"  policy_id          : {meta.policy_id}")
    print(f"  version            : {meta.version}")
    print(f"  doc_type           : {meta.doc_type.value}")
    print(f"  applies_to_actions : {meta.applies_to_actions}")
    print(f"  risk_level         : {meta.risk_level.value}")
    print(f"  mandatory          : {meta.mandatory}")
    print(f"  citation           : {meta.citation}")
    print("=" * 68)

    general = _general_splitter_chunks(body)
    policy_docs = build_policy_documents_from_file(path)
    policy = [d.page_content for d in policy_docs]

    print(f"\ngeneral splitter (CHUNK_SIZE={settings.CHUNK_SIZE}) : {len(general)} chunks")
    print(f"policy splitter  (CHUNK_SIZE={settings.POLICY_CHUNK_SIZE}) : {len(policy)} chunks")

    g_intact, p_intact = _intact(general), _intact(policy)
    print(f"\nrule 2.4 ('{THRESHOLD}' + its exception) intact in:")
    print(f"  general splitter : {g_intact} chunk(s)")
    print(f"  policy splitter  : {p_intact} chunk(s)")

    if g_intact == 0:
        print("\n  -> general splitter SPLIT the rule. Fragments containing the threshold:")
        for c in general:
            if THRESHOLD in c:
                print(f"      ...{c[-110:].strip()}")

    print("\n--- payload written to every policy chunk ---")
    for k, v in policy_docs[0].metadata.items():
        print(f"  {k}: {v}")

    print("\n--- policy chunks ---")
    for i, c in enumerate(policy):
        head = c.split("\n", 1)[0][:60]
        print(f"  [{i}] {len(c):4d} chars | {head}")

    assert p_intact >= 1, f"policy chunker split clause {CLAUSE} - threshold lost its exception"
    assert all(len(c) <= settings.POLICY_CHUNK_SIZE for c in policy), "chunk exceeded limit"
    print(f"\nPASS - clause {CLAUSE} survived intact and all chunks are within the size limit.")


if __name__ == "__main__":
    main()

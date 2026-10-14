"""
Read-only audit of the live Qdrant collection.

Reports point count, distinct sources, and duplicate chunks so we know what
we're migrating before Phase 0 touches anything.

Run from the rag-system directory:
    .venv/Scripts/python.exe -m scripts.inspect_collection
"""
import hashlib
from collections import Counter

from src.config.settings import settings
from src.config.qdrant_client import get_qdrant_client

CONTENT_KEY = "page_content"   # langchain_qdrant default
METADATA_KEY = "metadata"


def _vector_size(info) -> str:
    """Vector size, tolerating both single and named-vector configs."""
    try:
        params = info.config.params.vectors
        if hasattr(params, "size"):
            return str(params.size)
        return ", ".join(f"{k}={v.size}" for k, v in params.items())
    except Exception as exc:
        return f"<unreadable: {exc}>"


def main() -> None:
    client = get_qdrant_client()
    name = settings.QDRANT_COLLECTION

    info = client.get_collection(name)
    print("=" * 60)
    print(f"collection    : {name}")
    print(f"points_count  : {info.points_count}")
    print(f"vector size   : {_vector_size(info)}")
    print(f"status        : {info.status}")
    print("=" * 60)

    sources: Counter[str] = Counter()
    content_hashes: Counter[str] = Counter()
    hash_to_sample: dict[str, str] = {}
    total = 0
    first_payload = None

    offset = None
    while True:
        points, offset = client.scroll(
            collection_name=name,
            limit=256,
            offset=offset,
            with_payload=True,
            with_vectors=False,
        )
        for p in points:
            total += 1
            payload = p.payload or {}
            if first_payload is None:
                first_payload = payload

            meta = payload.get(METADATA_KEY) or {}
            src = meta.get("source", "<no source>") if isinstance(meta, dict) else "<no source>"
            sources[src] += 1

            content = payload.get(CONTENT_KEY) or ""
            h = hashlib.sha256(content.encode("utf-8")).hexdigest()
            content_hashes[h] += 1
            hash_to_sample.setdefault(h, content[:90].replace("\n", " "))

        if offset is None:
            break

    print(f"\nscanned {total} points\n")

    print("--- payload shape of first point ---")
    if first_payload:
        for k, v in first_payload.items():
            preview = str(v)[:110].replace("\n", " ")
            print(f"  {k}: {preview}")
    print()

    print("--- distinct sources ---")
    for src, n in sources.most_common():
        print(f"  {n:5d}  {src}")
    print()

    dupes = {h: n for h, n in content_hashes.items() if n > 1}
    unique = len(content_hashes)
    print("--- duplicates ---")
    print(f"  unique chunk texts : {unique}")
    print(f"  duplicated texts   : {len(dupes)}")
    print(f"  wasted points      : {total - unique}")
    if dupes:
        print("\n  worst offenders:")
        for h, n in sorted(dupes.items(), key=lambda kv: -kv[1])[:10]:
            print(f"    x{n:<4d} {hash_to_sample[h]}")


if __name__ == "__main__":
    main()

"""Seed EMP-REG sections; --prune-legacy backs up and removes finance points.

Run from rag-system: python -m scripts.seed_qdrant_policies --dry-run
Then: python -m scripts.seed_qdrant_policies --prune-legacy
No collection is dropped. Unrelated collections are never modified.
"""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from qdrant_client.http import models as qm

from src.config.qdrant_client import get_qdrant_client
from src.config.settings import settings
from src.core.embeddings.embedding_service import get_embeddings
from src.core.registration.corpus import load_corpus


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--prune-legacy", action="store_true")
    args = parser.parse_args()
    chunks = load_corpus()
    model = settings.API_EMBED_MODEL if settings.MODEL_PROVIDER in ("api", "openrouter") else settings.EMBED_MODEL
    print(f"Validated {len(chunks)} sections from 11 registration policies; collection={settings.POLICY_COLLECTION}; model={model}", flush=True)
    for pid in sorted({c['metadata']['policy_id'] for c in chunks}):
        print(f"  {pid}: {sum(c['metadata']['policy_id'] == pid for c in chunks)} sections")
    if args.dry_run:
        return
    client = get_qdrant_client()
    exists = client.collection_exists(settings.POLICY_COLLECTION)
    if exists:
        config = client.get_collection(settings.POLICY_COLLECTION).config.params.vectors
        if not isinstance(config, qm.VectorParams) or config.size != settings.EMBED_DIMENSION or config.distance != qm.Distance.COSINE:
            raise RuntimeError("Existing policy collection has incompatible vectors. Select a separate compatible POLICY_COLLECTION before seeding.")
    vectors = get_embeddings().embed_documents([c["text"] for c in chunks])
    if len(vectors) != len(chunks) or any(len(v) != settings.EMBED_DIMENSION for v in vectors):
        raise RuntimeError("Embedding response does not match corpus/dimension; nothing written")
    if not exists:
        client.create_collection(settings.POLICY_COLLECTION, vectors_config=qm.VectorParams(size=settings.EMBED_DIMENSION, distance=qm.Distance.COSINE))
    for key in ("policy_id", "flow", "field", "country", "version"):
        client.create_payload_index(settings.POLICY_COLLECTION, f"metadata.{key}", qm.PayloadSchemaType.KEYWORD, wait=True)
    client.create_payload_index(settings.POLICY_COLLECTION, "metadata.active", qm.PayloadSchemaType.BOOL, wait=True)
    points = [qm.PointStruct(id=c["id"], vector=v, payload={
        "text": c["text"], "page_content": c["text"],
        "metadata": {**c["metadata"], "embedding_model": model},
    }) for c, v in zip(chunks, vectors)]
    client.upsert(settings.POLICY_COLLECTION, points, wait=True)
    stored = client.retrieve(settings.POLICY_COLLECTION, ids=[p.id for p in points], with_payload=True)
    if len(stored) != len(points) or any(p.payload != next(x.payload for x in points if x.id == p.id) for p in stored):
        raise RuntimeError("Registration readback failed; legacy points were retained")
    print(f"Verified {len(stored)} registration sections in Qdrant.", flush=True)
    if args.prune_legacy:
        legacy, offset = [], None
        while True:
            page, offset = client.scroll(settings.POLICY_COLLECTION, offset=offset, limit=256, with_payload=True, with_vectors=True)
            for point in page:
                pid = (point.payload or {}).get("metadata", {}).get("policy_id", "")
                if pid.startswith(("FIN-", "PRIV-FIN-")):
                    legacy.append(point)
            if offset is None:
                break
        if legacy:
            backup = Path("var/backups") / f"finance-policy-points-{datetime.now(timezone.utc):%Y%m%dT%H%M%S%fZ}.json"
            backup.parent.mkdir(parents=True, exist_ok=True)
            backup.write_text(json.dumps([p.model_dump(mode="json") for p in legacy]), encoding="utf-8")
            client.delete(settings.POLICY_COLLECTION, qm.PointIdsList(points=[p.id for p in legacy]), wait=True)
            print(f"Removed {len(legacy)} obsolete finance chunks; backup: {backup}")
    print(f"Collection now has {client.count(settings.POLICY_COLLECTION, exact=True).count} points.")


if __name__ == "__main__":
    main()

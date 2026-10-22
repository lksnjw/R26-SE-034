"""Read-only export of policy-named Qdrant collections, without vectors.

Other collections are inventoried by schema/count only, not by document content.
Use --collection NAME to explicitly include a differently named policy collection.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import json
from pathlib import Path

from src.config.qdrant_client import get_qdrant_client
from src.config.settings import settings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collection", action="append", default=[])
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    output = args.output or Path("var/policy_inventory") / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    output.mkdir(parents=True, exist_ok=False)
    client = get_qdrant_client()
    names = sorted(c.name for c in client.get_collections().collections)
    if set(args.collection) - set(names):
        raise ValueError("Requested collection does not exist")
    inventory = []
    for index, name in enumerate(names):
        info = client.get_collection(name)
        selected = name == settings.POLICY_COLLECTION or "policy" in name.lower() or "policies" in name.lower() or name in args.collection
        item = dict(collection=name, points_count=info.points_count,
                    indexed_payload_fields=sorted(info.payload_schema), exported=selected,
                    used_by_registration=name == settings.POLICY_COLLECTION)
        if selected:
            records, offset = [], None
            while True:
                page, offset = client.scroll(name, limit=256, offset=offset, with_payload=True, with_vectors=False)
                records.extend({"id": str(p.id), "payload": p.payload or {}} for p in page)
                if offset is None:
                    break
            target = output / f"collection_{index:02d}"
            target.mkdir()
            (target / "payloads.json").write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
            def value(payload, key):
                metadata = payload.get("metadata") or {}
                return metadata.get(key, payload.get(key))
            item.update(export_directory=target.name, exported_records=len(records),
                count_matches=info.points_count == len(records),
                payload_keys=sorted({k for r in records for k in r["payload"]}),
                metadata_keys=sorted({k for r in records for k in (r["payload"].get("metadata") or {})}),
                policy_ids=dict(Counter(str(value(r["payload"], "policy_id")) for r in records)),
                flows=dict(Counter(str(value(r["payload"], "flow")) for r in records)))
            document = [f"# Exported policies: {name}", "", "Read-only database snapshot; not automatically registered as application authority.", ""]
            for record in records:
                payload = record["payload"]
                metadata = payload.get("metadata") or {k: v for k, v in payload.items() if k not in {"text", "page_content", "content"}}
                text = payload.get("text") or payload.get("page_content") or payload.get("content") or "[No recognized text field; inspect payloads.json.]"
                document.extend([f"## Point {record['id']}", "", "Metadata:", "", "```json", json.dumps(metadata, ensure_ascii=False, indent=2), "```", "", str(text), "", "---", ""])
            (target / "POLICIES.md").write_text("\n".join(document), encoding="utf-8")
            print(json.dumps(item, ensure_ascii=True), flush=True)
        inventory.append(item)
    (output / "inventory.json").write_text(json.dumps(inventory, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Snapshot: {output.resolve()}", flush=True)
    print(f"Inventoried {len(inventory)} collections; exported {sum(i['exported'] for i in inventory)} policy collections.", flush=True)


if __name__ == "__main__":
    main()

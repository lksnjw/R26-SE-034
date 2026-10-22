"""Section-aware ingestion of the eleven authoritative synthetic policies."""
import hashlib
import re
import uuid
from pathlib import Path

FLOW = "employee_registration"
POLICY_DIR = Path(__file__).resolve().parents[3] / "fixtures" / "employee_registration_policies_sri_lanka"
FIELDS = {
    "EMP-REG-001": ["requester"],
    "EMP-REG-002": ["first_name", "middle_name", "last_name"],
    "EMP-REG-003": ["gender", "birth_date"],
    "EMP-REG-004": ["phone"],
    "EMP-REG-005": ["location"],
    "EMP-REG-006": ["email"],
    "EMP-REG-007": ["language", "time_zone"],
    "EMP-REG-008": ["duplicates", "email", "phone", "first_name", "middle_name", "last_name", "birth_date"],
    "EMP-REG-009": ["completeness"],
    "EMP-REG-010": ["decision", "audit"],
    "EMP-REG-011": ["workflow"],
}
GLOBAL_IDS = {"EMP-REG-001", "EMP-REG-008", "EMP-REG-009", "EMP-REG-010", "EMP-REG-011"}
SECTION_FIELDS = {"Gender": ["gender"], "Birth Date": ["birth_date"], "Language": ["language"], "Time Zone": ["time_zone"]}


def load_corpus(directory: Path = POLICY_DIR) -> list[dict]:
    chunks = []
    seen = set()
    # Never ingest the combined .txt export or README as duplicate authority.
    for path in sorted(directory.glob("EMP-REG-*.md")):
        pid = path.name[:11]
        if pid not in FIELDS or pid in seen:
            raise ValueError(f"Unexpected or duplicate policy: {path.name}")
        seen.add(pid)
        text = path.read_text(encoding="utf-8-sig")
        title = text.splitlines()[0].lstrip("# ")
        if not title.startswith(pid):
            raise ValueError(f"Policy heading does not match filename: {path.name}")
        digest = hashlib.sha256(text.encode()).hexdigest()
        sections = re.split(r"(?m)^## ", text)
        for index, section in enumerate(sections[1:]):
            heading, _, body = section.partition("\n")
            if not body.strip():
                continue
            content = f"{title}\n\n## {heading}\n{body.strip()}"
            chunks.append({
                "id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"{FLOW}/{pid}/1.0/{index}")),
                "text": content,
                "metadata": {
                    "policy_id": pid, "policy_name": title, "flow": FLOW,
                    "field": SECTION_FIELDS.get(heading, FIELDS[pid]),
                    "country": "Sri Lanka", "version": "1.0", "active": True,
                    "section": heading, "chunk_index": index,
                    "source_document": path.name, "source_sha256": digest,
                },
            })
    if seen != set(FIELDS) or {c['metadata']['policy_id'] for c in chunks} != set(FIELDS):
        raise ValueError("All eleven EMP-REG policies, with nonempty sections, are required")
    return chunks

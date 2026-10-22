"""Registration gate: retrieve, check, judge uncertainty, and persist audit."""
import asyncio
import hashlib
import json
import logging
import os
import threading
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from pydantic import Field
from qdrant_client.http import models as qm

from src.config.qdrant_client import get_qdrant_client
from src.config.settings import settings
from src.core.llm.llm_service import get_judge_llm
from src.core.registration.retriever import RegistrationRetriever
from src.core.registration.validation import validate
from src.types.registration import Finding, RegistrationRequest, RegistrationResponse, StrictModel

SRI_LANKA = timezone(timedelta(hours=5, minutes=30))
_AUDIT_LOCK = threading.Lock()
logger = logging.getLogger(__name__)


class NarrativeResult(StrictModel):
    verdict: Literal["ALLOW", "BLOCK", "ESCALATE"]
    justification: str = Field(min_length=1)
    findings: list[Finding]
    cited_policies: list[str]


async def judge_uncertainty(employee, requester, chunks, today):
    """The LLM cannot overwrite deterministic checks or normalize form values."""
    system = """You validate Sri Lankan employee registration using ONLY the supplied
authoritative synthetic policies,
"""
    context = {
        "policies": [{"policy_id": c["metadata"]["policy_id"], "text": c["text"]} for c in chunks if c["metadata"]["policy_id"] in {"EMP-REG-003", "EMP-REG-005"}],
        "employee": employee.model_dump(), "requester": requester.model_dump(), "today_in_sri_lanka": str(today),
    }
    response = await asyncio.wait_for(get_judge_llm().ainvoke([("system", system), ("human", json.dumps(context, ensure_ascii=False))]), timeout=60)
    result = NarrativeResult.model_validate_json(response.content)
    allowed = {"EMP-REG-003": "birth_date", "EMP-REG-005": "location"}
    retrieved = {c["policy_id"] for c in context["policies"]}
    cited = set(result.cited_policies)
    required_citations = set(allowed) if result.verdict == "ALLOW" else {f.policy_id for f in result.findings}
    if not cited or not cited.issubset(retrieved) or not required_citations.issubset(cited) or any(allowed.get(f.policy_id) != f.field for f in result.findings):
        raise ValueError(f"Invalid narrative citations: {sorted(cited)}")
    expected = "BLOCK" if any(f.verdict == "BLOCK" for f in result.findings) else "ESCALATE" if result.findings else "ALLOW"
    if result.verdict != expected:
        raise ValueError("Judge verdict and findings disagree")
    return result.findings


def write_audit(record: dict) -> None:
    if settings.REGISTRATION_AUDIT_BACKEND == "qdrant":
        if settings.REGISTRATION_AUDIT_COLLECTION in {settings.POLICY_COLLECTION, settings.QDRANT_COLLECTION}:
            raise ValueError("Audit records require a separate collection")
        result = get_qdrant_client().upsert(
            collection_name=settings.REGISTRATION_AUDIT_COLLECTION,
            points=[qm.PointStruct(id=record["audit_id"], vector={}, payload={"record_type": "employee_registration_validation", **record})],
            wait=True,
        )
        if result.status != qm.UpdateStatus.COMPLETED:
            raise RuntimeError("Audit write did not complete")
        return
    path = Path(settings.REGISTRATION_AUDIT_PATH)
    with _AUDIT_LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")
            stream.flush()
            os.fsync(stream.fileno())


async def evaluate(request: RegistrationRequest, *, retriever=None, judge=None, audit_writer=None, now=None) -> RegistrationResponse:
    now = now or datetime.now(SRI_LANKA)
    chunks = []
    retrieval_failed = False
    try:
        service = retriever if retriever is not None else RegistrationRetriever()
        chunks = await asyncio.to_thread(service.retrieve)
    except Exception:
        retrieval_failed = True
    employee, findings = validate(request, now.astimezone(SRI_LANKA).date())
    if retrieval_failed:
        findings.append(Finding(verdict="ESCALATE", policy_id="EMP-REG-010", field="policy_context", reason="The complete current registration policy context could not be retrieved; retry after restoring the policy service."))
    if chunks and not any(f.verdict == "BLOCK" for f in findings):
        try:
            findings.extend(await (judge or judge_uncertainty)(employee, request.requester, chunks, now.astimezone(SRI_LANKA).date()))
        except Exception as exc:
            logger.warning("Registration narrative validation failed: %s: %s", type(exc).__name__, exc)
            findings.append(Finding(verdict="ESCALATE", policy_id="EMP-REG-010", field="policy_context", reason="Narrative policy validation is unavailable or invalid; human review is required."))

    verdict = "BLOCK" if any(f.verdict == "BLOCK" for f in findings) else "ESCALATE" if findings else "ALLOW"
    audit = {
        "audit_id": str(uuid.uuid4()), "requester_id": request.requester.user_id,
        "timestamp": now.isoformat(), "employee_reference": request.employee_reference,
        "submission_sha256": hashlib.sha256(request.employee.model_dump_json().encode()).hexdigest(),
        "normalized_submission_sha256": hashlib.sha256(employee.model_dump_json().encode()).hexdigest(),
        "validation_result": verdict, "failed_policy_ids": sorted({f.policy_id for f in findings}),
        "failed_fields": sorted({f.field for f in findings}),
        "policies": sorted({c["metadata"]["policy_id"] for c in chunks}),
        "policy_sources": {c["metadata"]["policy_id"]: c["metadata"]["source_sha256"] for c in chunks},
        "duplicate_check_reference": request.duplicate_check.reference if request.duplicate_check else None,
        "manual_override": None,
    }
    try:
        await asyncio.to_thread(audit_writer or write_audit, audit)
        audit["recorded"] = True
    except Exception:
        findings.append(Finding(verdict="ESCALATE", policy_id="EMP-REG-010", field="audit", reason="Audit persistence failed; creation cannot proceed."))
        verdict = "BLOCK" if verdict == "BLOCK" else "ESCALATE"
        audit.update(recorded=False, validation_result=verdict, failed_policy_ids=sorted({f.policy_id for f in findings}), failed_fields=sorted({f.field for f in findings}))
    return RegistrationResponse(
        verdict=verdict, justification=" ".join(f.reason for f in findings) or "All registration policy checks passed.",
        failed_policies=sorted({f.policy_id for f in findings}), failed_fields=sorted({f.field for f in findings}),
        normalized_employee=employee, findings=findings, retrieved_policies=audit["policies"], audit=audit,
        can_create=verdict == "ALLOW" and audit["recorded"],
    )

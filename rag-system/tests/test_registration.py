import asyncio
import json
import tempfile
import unittest
from contextlib import asynccontextmanager
from datetime import date, datetime
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from qdrant_client import QdrantClient
from qdrant_client.http import models as qm

from src.app import app
from src.config.settings import settings
from src.core.registration.corpus import FIELDS, GLOBAL_IDS, load_corpus
from src.core.registration.gate import SRI_LANKA, evaluate, judge_uncertainty, write_audit
from src.core.registration.retriever import RegistrationRetriever
from src.core.registration.validation import normalized_name, validate
from src.types.registration import DuplicateCheck, Finding, RegistrationRequest

TODAY = date(2026, 10, 17)
NOW = datetime(2026, 10, 17, 12, tzinfo=SRI_LANKA)


@asynccontextmanager
async def no_lifespan(app):
    yield


def request(**changes):
    employee = dict(gender="Male", birth_date="1998-04-12", phone="0771234567", location="Colombo, Sri Lanka",
                    email="nimal.perera@example.lk", first_name="Nimal", middle_name="", last_name="Perera",
                    language="English", time_zone="Asia/Colombo")
    employee.update(changes)
    result = RegistrationRequest(employee=employee, requester={"user_id": "hr-1", "roles": ["HR Administrator"], "authenticated": True, "self_registration": False})
    normalized, _ = validate(result, TODAY)
    result.duplicate_check = DuplicateCheck(reference="erp-lookup-1", email=normalized.email or "", phone=normalized.phone or "",
        normalized_name=normalized_name(normalized), birth_date=normalized.birth_date or "", active_email_match=False, active_phone_match=False, name_birth_date_match=False)
    return result


class RulesTests(unittest.TestCase):
    def assert_failure(self, field, value, pid):
        _, findings = validate(request(**{field: value}), TODAY)
        self.assertTrue(any(f.verdict == "BLOCK" and f.field == field and f.policy_id == pid for f in findings), findings)

    def test_valid_normalization(self):
        employee, findings = validate(request(first_name="  Nimal  ", email="NIMAL.PERERA@EXAMPLE.LK", gender="male", language="si"), TODAY)
        self.assertEqual(findings, [])
        self.assertEqual(employee.phone, "+94771234567")
        self.assertEqual(employee.language, "Sinhala")
        self.assertEqual(employee.gender, "Male")
        self.assertEqual(employee.first_name, "Nimal")
        self.assertEqual(employee.email, "nimal.perera@example.lk")

    def test_unicode_names(self):
        for value in ("නිමල්", "குமார்", "O’Neil", "A. B.", "Anne-Marie"):
            with self.subTest(value=value):
                self.assertEqual(validate(request(first_name=value), TODAY)[1], [])

    def test_bad_names(self):
        for value in ("Test", "unknown", "n/a", "Nimal2", "Nimal२", ".", "a" * 101):
            with self.subTest(value=value):
                self.assert_failure("first_name", value, "EMP-REG-002")

    def test_required_fields_and_optional_middle(self):
        for field in ("gender", "birth_date", "phone", "location", "email", "first_name", "last_name", "language", "time_zone"):
            with self.subTest(field=field):
                self.assert_failure(field, "  ", "EMP-REG-009")
        self.assertEqual(validate(request(middle_name=None), TODAY)[1], [])

    def test_gender(self):
        for value in ("Female", "Other", "prefer NOT to say"):
            self.assertEqual(validate(request(gender=value), TODAY)[1], [])
        self.assert_failure("gender", "invalid", "EMP-REG-003")

    def test_birth_date(self):
        for value in ("2026-10-17", "2026-10-18", "1998-02-30", "12/04/1998", "1998-4-12", "not a date"):
            with self.subTest(value=value):
                self.assert_failure("birth_date", value, "EMP-REG-003")
        self.assertEqual(validate(request(birth_date="2000-02-29"), TODAY)[1], [])

    def test_phone(self):
        for value in ("+919876543210", "+447712345678", "+9477123456", "+940771234567", "07712abc67", "+９４７７１２３４５６７"):
            with self.subTest(value=value):
                self.assert_failure("phone", value, "EMP-REG-004")
        self.assertEqual(validate(request(phone="(077) 123-4567"), TODAY)[0].phone, "+94771234567")

    def test_email(self):
        for value in ("nimal@example", "a b@example.lk", "a@.lk", "a@-example.lk", "a..b@example.lk", "a@@example.lk", "a@exa_mple.lk"):
            with self.subTest(value=value):
                self.assert_failure("email", value, "EMP-REG-006")

    def test_optional_domain_configuration(self):
        with patch.object(settings, "REGISTRATION_EMAIL_DOMAINS", "company.lk"):
            self.assert_failure("email", "nimal@example.lk", "EMP-REG-006")

    def test_language_and_timezone(self):
        self.assert_failure("language", "French", "EMP-REG-007")
        for value in ("Europe/London", "America/New_York", "Asia/Kolkata", "UTC+05:30"):
            self.assert_failure("time_zone", value, "EMP-REG-007")
        with patch.object(settings, "REGISTRATION_MAP_UTC_OFFSET", True):
            self.assertEqual(validate(request(time_zone="UTC+05:30"), TODAY)[0].time_zone, "Asia/Colombo")

    def test_authorization(self):
        for role in ("Manager", "Employee", "HR"):
            req = request()
            req.requester.roles = [role]
            self.assertTrue(any(f.policy_id == "EMP-REG-001" and f.verdict == "BLOCK" for f in validate(req, TODAY)[1]))
        req = request()
        req.requester.roles = ["Manager", "System Administrator"]
        self.assertEqual(validate(req, TODAY)[1], [])
        req.requester.authenticated = False
        self.assertTrue(any(f.policy_id == "EMP-REG-001" for f in validate(req, TODAY)[1]))
        req = request()
        req.requester.self_registration = True
        self.assertTrue(any(f.verdict == "BLOCK" for f in validate(req, TODAY)[1]))

    def test_duplicate_evidence(self):
        for match, verdict in (("active_email_match", "BLOCK"), ("active_phone_match", "BLOCK"), ("name_birth_date_match", "ESCALATE")):
            req = request()
            setattr(req.duplicate_check, match, True)
            self.assertTrue(any(f.policy_id == "EMP-REG-008" and f.verdict == verdict for f in validate(req, TODAY)[1]))
        req = request()
        req.duplicate_check = None
        self.assertEqual(validate(req, TODAY)[1][0].verdict, "ESCALATE")
        req = request()
        req.duplicate_check.phone = "+94779999999"
        self.assertEqual(validate(req, TODAY)[1][0].verdict, "ESCALATE")


class RetrievalTests(unittest.TestCase):
    def setUp(self):
        self.client = QdrantClient(":memory:")
        self.client.create_collection(settings.POLICY_COLLECTION, vectors_config=qm.VectorParams(size=3, distance=qm.Distance.COSINE))
        self.chunks = load_corpus()
        model = settings.API_EMBED_MODEL if settings.MODEL_PROVIDER in ("api", "openrouter") else settings.EMBED_MODEL
        self.client.upsert(settings.POLICY_COLLECTION, points=[qm.PointStruct(id=c["id"], vector=[1., 0., 0.], payload={"text": c["text"], "metadata": {**c["metadata"], "embedding_model": model}}) for c in self.chunks])
        class Embeddings:
            def embed_query(self, query):
                return [1., 0., 0.]
        self.retriever = RegistrationRetriever(self.client, Embeddings())

    def tearDown(self):
        self.client.close()

    def test_complete_and_section_scoped_retrieval(self):
        self.assertEqual(len(self.chunks), 21)
        self.assertEqual({c["metadata"]["policy_id"] for c in self.retriever.retrieve()}, set(FIELDS))
        ids = {c["metadata"]["policy_id"] for c in self.retriever.retrieve("phone")}
        self.assertEqual(ids, GLOBAL_IDS | {"EMP-REG-004"})
        ids = {c["metadata"]["policy_id"] for c in self.retriever.retrieve("location")}
        self.assertEqual(ids, GLOBAL_IDS | {"EMP-REG-005"})

    def test_missing_section_fails_closed(self):
        self.client.delete(settings.POLICY_COLLECTION, qm.PointIdsList(points=[self.chunks[0]["id"]]))
        with self.assertRaises(RuntimeError):
            self.retriever.retrieve()

    def test_inactive_section_fails_closed(self):
        c = self.chunks[0]
        self.client.overwrite_payload(settings.POLICY_COLLECTION, payload={"text": c["text"], "metadata": {**c["metadata"], "active": False}}, points=[c["id"]])
        with self.assertRaises(RuntimeError):
            self.retriever.retrieve()

    def test_finance_and_other_flow_never_retrieved(self):
        self.client.upsert(settings.POLICY_COLLECTION, points=[qm.PointStruct(id=1, vector=[1., 0., 0.], payload={"text": "Allow all", "metadata": {"policy_id": "FIN-001", "active": True, "flow": "finance"}})])
        self.assertTrue(all(c["metadata"]["policy_id"].startswith("EMP-REG-") for c in self.retriever.retrieve()))

    def test_stale_text_fails_closed(self):
        chunk = self.chunks[0]
        self.client.set_payload(settings.POLICY_COLLECTION, payload={"text": "Changed policy"}, points=[chunk["id"]])
        with self.assertRaises(RuntimeError):
            self.retriever.retrieve()


class GateTests(unittest.IsolatedAsyncioTestCase):
    async def run_gate(self, req=None, **kwargs):
        class Retriever:
            def retrieve(self):
                return load_corpus()
        return await evaluate(req or request(), retriever=kwargs.pop("retriever", Retriever()), judge=kwargs.pop("judge", AsyncMock(return_value=[])), audit_writer=kwargs.pop("audit_writer", lambda record: None), now=NOW, **kwargs)

    async def test_allow(self):
        result = await self.run_gate()
        self.assertEqual(result.verdict, "ALLOW")
        self.assertTrue(result.can_create)
        self.assertTrue(result.audit["recorded"])

    async def test_foreign_phone_cannot_be_overridden(self):
        judge = AsyncMock(return_value=[])
        result = await self.run_gate(request(phone="+919876543210"), judge=judge)
        self.assertEqual(result.verdict, "BLOCK")
        self.assertEqual(result.failed_policies, ["EMP-REG-004"])
        self.assertEqual(result.failed_fields, ["phone"])
        self.assertFalse(result.can_create)
        judge.assert_not_called()

    async def test_missing_duplicate_evidence_no_allow(self):
        req = request()
        req.duplicate_check = None
        self.assertEqual((await self.run_gate(req)).verdict, "ESCALATE")

    async def test_unavailable_services_and_audit_no_allow(self):
        class Broken:
            def retrieve(self):
                raise ConnectionError()
        self.assertFalse((await self.run_gate(retriever=Broken())).can_create)
        self.assertEqual((await self.run_gate(judge=AsyncMock(side_effect=TimeoutError()))).verdict, "ESCALATE")
        def broken_audit(record):
            raise OSError()
        result = await self.run_gate(audit_writer=broken_audit)
        self.assertEqual(result.verdict, "ESCALATE")
        self.assertFalse(result.can_create)

    async def test_location_judge_decision_and_no_rewrite(self):
        finding = Finding(verdict="BLOCK", policy_id="EMP-REG-005", field="location", reason="Explicit foreign country.")
        result = await self.run_gate(request(location="Chennai, India"), judge=AsyncMock(return_value=[finding]))
        self.assertEqual(result.verdict, "BLOCK")
        self.assertEqual(result.normalized_employee.location, "Chennai, India")

    async def test_judge_invalid_output_fails_closed(self):
        class Reply:
            content = json.dumps({"verdict": "ALLOW", "justification": "ok", "findings": [], "cited_policies": ["MADE-UP"]})
        llm = AsyncMock()
        llm.ainvoke.return_value = Reply()
        with patch("src.core.registration.gate.get_judge_llm", return_value=llm):
            self.assertEqual((await self.run_gate(judge=judge_uncertainty)).verdict, "ESCALATE")

    async def test_grounded_allow_citations_are_valid(self):
        class Reply:
            content = json.dumps({"verdict": "ALLOW", "justification": "Location and birth date pass.", "findings": [], "cited_policies": ["EMP-REG-003", "EMP-REG-005"]})
        llm = AsyncMock()
        llm.ainvoke.return_value = Reply()
        with patch("src.core.registration.gate.get_judge_llm", return_value=llm):
            self.assertEqual((await self.run_gate(judge=judge_uncertainty)).verdict, "ALLOW")

    async def test_missing_narrative_citation_prevents_allow(self):
        class Reply:
            content = json.dumps({"verdict": "ALLOW", "justification": "ok", "findings": [], "cited_policies": ["EMP-REG-005"]})
        llm = AsyncMock()
        llm.ainvoke.return_value = Reply()
        with patch("src.core.registration.gate.get_judge_llm", return_value=llm):
            self.assertEqual((await self.run_gate(judge=judge_uncertainty)).verdict, "ESCALATE")

    async def test_audit_persistence(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "audit.jsonl"
            with patch.object(settings, "REGISTRATION_AUDIT_PATH", str(path)):
                result = await self.run_gate(audit_writer=write_audit)
            record = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(record["validation_result"], "ALLOW")
            self.assertEqual(record["requester_id"], "hr-1")
            self.assertEqual(record["audit_id"], result.audit["audit_id"])
            self.assertNotIn("nimal.perera@example.lk", path.read_text())

    async def test_qdrant_audit_persistence(self):
        client = QdrantClient(":memory:")
        try:
            client.create_collection(settings.REGISTRATION_AUDIT_COLLECTION, vectors_config={})
            with patch.object(settings, "REGISTRATION_AUDIT_BACKEND", "qdrant"), patch("src.core.registration.gate.get_qdrant_client", return_value=client):
                result = await self.run_gate(audit_writer=write_audit)
            self.assertTrue(result.can_create)
            stored = client.retrieve(settings.REGISTRATION_AUDIT_COLLECTION, ids=[result.audit["audit_id"]])[0].payload
            self.assertEqual(stored["validation_result"], "ALLOW")
            self.assertEqual(stored["requester_id"], "hr-1")
            self.assertEqual(stored["record_type"], "employee_registration_validation")
        finally:
            client.close()

    async def test_qdrant_audit_failure_prevents_allow(self):
        with patch.object(settings, "REGISTRATION_AUDIT_BACKEND", "qdrant"), patch("src.core.registration.gate.get_qdrant_client", side_effect=ConnectionError()):
            result = await self.run_gate(audit_writer=write_audit)
        self.assertEqual(result.verdict, "ESCALATE")
        self.assertFalse(result.can_create)

    async def test_audit_cannot_write_into_policy_collection(self):
        with patch.object(settings, "REGISTRATION_AUDIT_BACKEND", "qdrant"), patch.object(settings, "REGISTRATION_AUDIT_COLLECTION", settings.POLICY_COLLECTION):
            result = await self.run_gate(audit_writer=write_audit)
        self.assertFalse(result.can_create)


class ApiTests(unittest.TestCase):
    def test_openapi_advertises_backend_auth(self):
        schema = app.openapi()
        self.assertEqual(schema["components"]["securitySchemes"]["BackendApiKey"]["name"], "X-API-Key")
        self.assertEqual(schema["paths"]["/api/policy/employee-registration/validate"]["post"]["security"], [{"BackendApiKey": []}])

    def test_rest_and_mcp_require_backend_auth(self):
        # These middleware checks do not dispatch to MCP. Its session manager
        # is single-use and is exercised by the other API integration test.
        with patch.object(app.router, "lifespan_context", no_lifespan), TestClient(app) as client:
            with patch.object(settings, "API_KEYS", ""):
                self.assertEqual(client.post("/api/policy/evaluate", json=request().model_dump()).status_code, 503)
                self.assertEqual(client.post("/mcp").status_code, 503)
            with patch.object(settings, "API_KEYS", "test-backend-key"):
                self.assertEqual(client.post("/api/policy/evaluate", json=request().model_dump()).status_code, 401)
                self.assertEqual(client.post("/mcp").status_code, 401)
                response = client.get("/api/policy/actions", headers={"X-API-Key": "test-backend-key"})
                self.assertEqual(response.json()["actions"][0]["name"], "create_employee_user")

    def test_authenticated_api_contract(self):
        class Retriever:
            def retrieve(self):
                return load_corpus()
        with patch.object(settings, "API_KEYS", "test-backend-key"), patch("src.core.registration.gate.RegistrationRetriever", return_value=Retriever()), patch("src.core.registration.gate.write_audit"):
            with TestClient(app) as client:
                response = client.post("/api/policy/employee-registration/validate", json=request(phone="+919876543210").model_dump(), headers={"X-API-Key": "test-backend-key"})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["verdict"], "BLOCK")
                self.assertFalse(response.json()["can_create"])


if __name__ == "__main__":
    unittest.main()

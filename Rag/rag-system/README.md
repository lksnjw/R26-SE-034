# Sri Lanka Employee Registration Policy Gate

This service validates employee registration before the ERP creates a user.
For an NLP request or uploaded document, the upstream model first extracts the
employee fields into the JSON schema below. It then submits those extracted
fields to this gate and shows the returned decision. Document parsing/extraction
stays in that upstream component; RAG supplies the policy context for validation.
Its only active flow is `employee_registration`. It returns `ALLOW`, `BLOCK`,
or `ESCALATE`; it never calls an ERP write API.

For the main-system developer, use [the API handoff guide](docs/MAIN_SYSTEM_HANDOFF.md),
[OpenAPI contract](docs/integration/openapi.json), and
[Postman collection](docs/integration/postman_collection.json). These contain no secrets.

The authoritative synthetic policies are the eleven `EMP-REG-*.md` files in
[`fixtures/employee_registration_policies_sri_lanka`](fixtures/employee_registration_policies_sri_lanka).
Their text is preserved. The seed script ingests 21 heading-level sections;
the combined `.txt` export and README are not ingested. Old finance documents
and fixture payloads are in `archive/finance` and are not searched or seeded.
The older finance implementation remains in the repository for research
comparison; its API, assist route and demo page are no longer mounted.

## Setup

From `Rag/rag-system`, use the existing `.env` for Qdrant and embedding/chat
providers. Set `API_KEYS` to a secret shared **only with the trusted ERP backend**.
An empty key configuration returns HTTP 503; it does not disable authentication.
Never embed this key in the employee form or give it to an untrusted agent.

```powershell
.\.venv\Scripts\python.exe -m scripts.seed_qdrant_policies --dry-run
.\.venv\Scripts\python.exe -m scripts.seed_qdrant_policies --prune-legacy
.\.venv\Scripts\python.exe -m uvicorn src.app:app --port 8000
```

Seeding upserts stable IDs after all embeddings succeed. `--prune-legacy` backs
up existing `FIN-*` / `PRIV-FIN-*` points to `var/backups/` and removes them only
after registration points are read back successfully. It does not drop collections
or alter ERP vector collections. `rag_docs` company records are not policy authority
and are never queried by this flow. There is no `--recreate` option.

Optional configuration:

```dotenv
REGISTRATION_EMAIL_DOMAINS=
REGISTRATION_MAP_UTC_OFFSET=False
REGISTRATION_AUDIT_PATH=var/registration_audit.jsonl
REGISTRATION_AUDIT_BACKEND=file
REGISTRATION_AUDIT_COLLECTION=registration_audit
```

The empty domain list imposes no corporate-domain restriction. Set a list only
when supplied by the company. `UTC+05:30` is accepted only when its explicit
mapping is enabled; `Asia/Kolkata` is always rejected. Local runs default to a file
audit sink. Hosted deployments use `REGISTRATION_AUDIT_BACKEND=qdrant` with a
separate payload-only audit collection. Initialize it once with
`python -m scripts.prepare_registration_audit`; it does not change policy vectors.
If using the file sink in a container, mount persistent writable storage.
Audit write failure prevents ALLOW with either backend.

## Backend integration

`POST /api/policy/employee-registration/validate` (alias: `/api/policy/evaluate`)
requires `X-API-Key`. Swagger schema: `/docs`. Health: `/health`.
The former finance request/response format is replaced.

```json
{
  "employee": {
    "gender": "Male",
    "birth_date": "1998-04-12",
    "phone": "0771234567",
    "location": "Colombo, Sri Lanka",
    "email": "nimal.perera@example.lk",
    "first_name": "Nimal",
    "middle_name": "",
    "last_name": "Perera",
    "language": "English",
    "time_zone": "Asia/Colombo"
  },
  "requester": {
    "user_id": "authenticated-hr-user-id",
    "roles": ["HR Administrator"],
    "authenticated": true,
    "self_registration": false
  },
  "employee_reference": "registration-request-123",
  "duplicate_check": {
    "reference": "erp-active-user-lookup-123",
    "email": "nimal.perera@example.lk",
    "phone": "+94771234567",
    "normalized_name": "nimal perera",
    "birth_date": "1998-04-12",
    "active_email_match": false,
    "active_phone_match": false,
    "name_birth_date_match": false
  }
}
```

Requester identity/roles/self-registration and duplicate-check results **must be
constructed by the authenticated ERP backend**, never copied from browser input
or an LLM. This repository has no ERP identity provider, active-user lookup API,
or create-user endpoint. The adapter contract above is the integration boundary.
Missing duplicate evidence or evidence for different normalized values returns
ESCALATE. Do not send `false` match flags unless the ERP lookup actually succeeded.

Name comparison uses NFC normalization, whitespace collapsing, first/middle/last
concatenation and Unicode case folding. Email uses trimmed lowercase comparison;
phone uses the normalized +94 value. The backend must use the same normalization
when checking active records. Recheck uniqueness atomically during creation to
prevent concurrent submissions from creating duplicates.

Only continue when HTTP succeeded, `verdict == "ALLOW"` and `can_create == true`.
Create from `normalized_employee` for that exact validated submission. If form
data or requester changes, validate again. BLOCK stops the request; ESCALATE goes
to human review. Unknown results, timeouts and non-2xx responses must stop creation.
Manual review must be recorded by the ERP; this API does not expose an override.

Example violation response (additional normalization and audit fields omitted):

```json
{
  "verdict": "BLOCK",
  "justification": "Phone must normalize to Sri Lanka country code +94 followed by exactly 9 digits; foreign country codes are blocked.",
  "failed_policies": ["EMP-REG-004"],
  "failed_fields": ["phone"],
  "can_create": false
}
```

MCP `/mcp` exposes `check_policy(request)` with the same schema and backend
authentication. Calling an optional agent tool is not enforcement: the ERP
backend must invoke validation unconditionally before its create-user operation.

## Retrieval and validation

Payloads contain `text`, `page_content`, and nested `metadata`: `policy_id`,
`policy_name`, `flow`, `field` (array), `country`, `version`, `active`, `section`,
`source_document`, `source_sha256`, `chunk_index`, `embedding_model`.

Queries filter `flow=employee_registration`, `active=true`, `country=Sri Lanka`,
and optionally `field`. Every relevant section is read by predicate; filtered
semantic search supplements it. Full submissions require all eleven policies;
field queries include the five cross-cutting policies. Missing/stale sections
or changed embedding models prevent ALLOW. Only field intent, not employee PII,
is sent for query embeddings.

Python enforces authorization, required fields, Unicode names, gender, calendar
dates, phone, email, language, time zone and duplicate evidence. The LLM receives
the submitted data, retrieved policies and verified requester to assess location
and clearly implausible birth dates. No age cutoff is invented. Unverifiable
geography, judge errors or malformed/unsupported citations require review. A
definite BLOCK always wins over review or model approval. Dates use Sri Lanka time.

Audit JSONL records requester ID, timestamp, employee reference, submission hashes,
verdict, failed policy IDs/fields, policy source hashes and duplicate lookup reference.
It avoids storing the employee form in the audit file; the configured LLM does
receive it for narrative validation. The local audit sink is intended for this
single-process prototype. The Qdrant backend keeps audits outside the container
and works across restarts/replicas, without embedding or searching employee records.

## Verification

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
.\.venv\Scripts\python.exe -m scripts.query_policies phone
.\.venv\Scripts\python.exe -m scripts.query_policies location
.\.venv\Scripts\python.exe -m scripts.eval_registration --repeat 2 --concurrency 2
```

Unit/integration tests use in-memory Qdrant and stub the narrative model. Live
retrieval and model checks require the configured services. Older `eval_gate`,
`eval_assist`, finance coverage scripts and finance documents under `docs/` describe
the archived prototype; they are not the registration API contract.

The registration benchmark contains 120 synthetic, policy-derived cases and
exports per-case responses, decision metrics, retrieval diagnostics, a
deterministic baseline and an explanation-review worksheet under
`var/evaluations/`. It uses isolated local audit files and never creates ERP
users. Use `--prepare-only` to inspect cases without live calls. Labels still
require independent review before claiming final research results; see
[the evaluation methodology](docs/RESEARCH_EVALUATION.md).

For a presentation of the recorded benchmark, open
[the offline HTML evaluation report](docs/evaluation.html). It includes searchable
cases, submitted data, decisions, retrieved policy context and the recorded
failure. Regenerate it with
`python -m scripts.render_evaluation var/evaluations/research-20261019`.


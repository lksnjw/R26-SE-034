# Integration guide: employee-registration validation

This API validates structured employee-registration data using EMP-REG-001 through
EMP-REG-011. It returns ALLOW, BLOCK or ESCALATE. It never creates ERP users.

The integration scope is validation only. Do not call `/api/assist`; the active
application does not expose that route. Use the registration JSON contract below,
not the former finance `prompt` / `actor` / `context` request.

For a complete request and response example, see [API_USAGE.md](API_USAGE.md).

## Connection

- Base URL: `https://policy-gate.victoriousglacier-3e6fd5f9.centralindia.azurecontainerapps.io`
- Validate: `POST /api/policy/employee-registration/validate`
- Interactive documentation: `/docs` (Authorize uses `X-API-Key`)
- OpenAPI: `/openapi.json`
- Health: `GET /health`
- Alias: `POST /api/policy/evaluate` uses the same registration schema.

Use HTTPS from the main system's **backend**. Set these backend environment variables:

```dotenv
POLICY_GATE_URL=https://policy-gate.victoriousglacier-3e6fd5f9.centralindia.azurecontainerapps.io
POLICY_GATE_API_KEY=<obtain privately from the deployment owner>
```

Send `X-API-Key: <POLICY_GATE_API_KEY>` and `Content-Type: application/json`.
This is the policy gate's inbound key, not the Gemini or Qdrant API key.
The deployment owner manages it as secret `gate-key` on Container App `policy-gate`
in resource group `rg-policy-gate`. Share it privately only with the backend owner;
do not put it in a browser bundle, model prompt, committed file, or shared Postman export.

Import [the Postman collection](integration/postman_collection.json), set the private
`gate_api_key` variable locally, and use [the exported schema](integration/openapi.json)
for client generation. The sample contains fictional data and **no duplicate proof**.
It is expected to ESCALATE until real duplicate-check results are supplied.

## Where the call belongs

```text
NLP request or uploaded document
    -> upstream model extracts employee fields
    -> backend adds authenticated requester + ERP duplicate lookup results
    -> POST policy gate
    -> show findings to the user or send to human review
    -> only ALLOW can continue to ERP create-user
```

This endpoint accepts JSON fields, not raw prompt text, PDF or image uploads.
Your model/document extractor supplies only the `employee` object. It must not
invent missing values or manufacture requester roles and duplicate-check results.

## Request

Start with [registration_request.json](../examples/registration_request.json).
The request has four objects/values:

| Property | Source | Meaning |
|---|---|---|
| `employee` | Form or upstream extraction model | Registration fields; middle name is optional |
| `requester` | Backend's authenticated session | User ID, verified roles, authenticated status, whether this is self-registration |
| `duplicate_check` | Backend's active-user lookup | Results bound to normalized values; use null when lookup is missing/unavailable |
| `employee_reference` | Backend | Your correlation/request ID; returned in audit information |

Requester roles must include `HR Administrator` or `System Administrator`.
If your system stores different internal role names, map them only after verifying
their actual permissions. Do not assign an administrator role just to make validation pass.
`self_registration: false` is also an assertion the backend must verify.

When your ERP lookup is implemented, supply this shape instead of null:

```json
{
  "reference": "actual-erp-lookup-reference",
  "email": "nimal.perera@example.lk",
  "phone": "+94771234567",
  "normalized_name": "nimal perera",
  "birth_date": "1998-04-12",
  "active_email_match": false,
  "active_phone_match": false,
  "name_birth_date_match": false
}
```

The boolean values above are an illustrative no-match result, not defaults.
Set them from actual successful lookups. Email/phone checks cover active employee
users. Same normalized name plus birth date requires human review.

Normalize for lookup using the same rules as the gate:

- Trim values, normalize Unicode to NFC and collapse repeated whitespace.
- Email: lowercase.
- Phone: remove spaces/hyphens/brackets; `0` plus 9 digits becomes `+94` plus 9 digits.
- Name: concatenate first, middle and last names with spaces, collapse whitespace,
  then Unicode case-fold. An empty middle name contributes no extra space.
- Birth date: canonical `YYYY-MM-DD`.

The gate checks that the evidence values match this submission. If they differ,
it returns ESCALATE and the lookup must be repeated. The final ERP creation must
also enforce uniqueness atomically, because two concurrent registrations can pass
an earlier lookup. Never treat missing lookup results as `false` matches.

## Response and UI behavior

Successful validation requests return HTTP 200 for **all three policy verdicts**.
HTTP 200 by itself is not permission to create a user.

| Field | Use |
|---|---|
| `verdict` | ALLOW / BLOCK / ESCALATE |
| `can_create` | True only for ALLOW with a recorded audit |
| `justification` | Overall explanation for the user |
| `findings[]` | Each has `verdict`, `policy_id`, `field`, `reason`; display field reasons in the form |
| `failed_fields` / `failed_policies` | Highlight affected inputs and show policy references |
| `normalized_employee` | Values approved/checked by the gate |
| `audit.audit_id` | Persist with your registration request for traceability |
| `audit.recorded` | Whether the policy decision was recorded |

The backend must require all of the following before calling create-user:

```javascript
const allowed = response.ok &&
  result.verdict === "ALLOW" &&
  result.can_create === true &&
  result.audit?.recorded === true;
```

On ALLOW use `normalized_employee` for the same requester/submission. A changed
field or requester requires validation again. Never let the LLM choose whether to
skip this gate. On BLOCK keep the form values and display findings for correction;
on ESCALATE route to human review. This API does not provide a bypass/override.

## Errors and timeouts

| HTTP status | Handling |
|---|---|
| 401 | Missing/wrong backend key; fix configuration, do not create |
| 422 | Request JSON does not match the schema; inspect `detail` and fix the integration |
| 503 | Gate authentication is not configured; contact deployment owner |
| 5xx / timeout / invalid JSON | Validation did not complete; do not create |

Allow a 120-second client timeout for model work and cold starts. A timeout is an
unknown result, never approval. Retrying validation can produce another audit ID;
the main system must separately prevent duplicate ERP create operations.

Missing mandatory employee values normally produce BLOCK findings. Missing
duplicate evidence produces ESCALATE. A clear violation takes precedence over
review findings. No required evidence is inferred from NLP text alone.

## Hosted audit

The Azure deployment uses the separate payload-only `registration_audit` Qdrant
collection, so records survive container restarts and scale-to-zero. Audit writes
must complete before an ALLOW is returned. Policies remain in `policy_docs`.

No real ERP creation is performed by the provided tests or Postman collection.

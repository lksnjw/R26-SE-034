# API usage: employee-registration validation

The current integration is validation only. The caller sends structured employee
fields and receives ALLOW, BLOCK or ESCALATE. There is no `/api/assist` route in
the active app. This service does not create users or extract fields from raw NLP,
PDFs or images; extraction belongs to the main system.

## Endpoint and authentication

```text
POST http://localhost:8000/api/policy/employee-registration/validate
```

```http
Content-Type: application/json
X-API-Key: YOUR_BACKEND_API_KEY
```

Use a key configured in the service's `API_KEYS`. Store it on the calling backend
as `POLICY_GATE_API_KEY`. For a hosted service, replace the local base URL with
the actual deployment URL. Do not put the key in frontend code, model prompts,
commits, or shared Postman exports.

- [Local Swagger documentation](http://localhost:8000/docs)
- [Local OpenAPI schema](http://localhost:8000/openapi.json)
- [Service setup and architecture](../README.md)

## Complete example request

This example contains fictional employee and requester details. The duplicate
flags illustrate a completed lookup with no matches; they are **not default values**.
Populate requester assertions from the authenticated session and duplicate evidence
from real ERP lookups. If no lookup is available, send `"duplicate_check": null`;
the gate cannot return ALLOW without that evidence.

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
    "reference": "actual-erp-lookup-reference",
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

All employee fields except `middle_name` are mandatory under policy. Names use
Unicode; dates use `YYYY-MM-DD`; language is English/Sinhala/Tamil (en/si/ta accepted);
time zone is `Asia/Colombo`. The complete checks live in the policy corpus.

The model may extract the `employee` values, but it must not fabricate the
requester identity, administrator role, self-registration flag or duplicate results.
Only verified HR Administrator/System Administrator roles can authorize creation.

The gate normalizes values. Duplicate evidence must refer to the same normalized
email, phone, name and birth date; the normalization rules are in the integration guide.

## Response

HTTP 200 means a validation response was returned. It does not mean ALLOW.

| Field | Purpose |
|---|---|
| `verdict` | `ALLOW`, `BLOCK` or `ESCALATE` |
| `justification` | Overall explanation to display |
| `findings` | Individual `{verdict, policy_id, field, reason}` entries |
| `failed_fields` | Form fields or checks needing attention |
| `failed_policies` | Relevant policy IDs |
| `normalized_employee` | Normalized form values |
| `retrieved_policies` | Policies consulted |
| `audit` | Audit ID, requester ID, timestamp, references, hashes, and `recorded` status |
| `can_create` | True only for ALLOW with a recorded audit |

For a foreign phone, the following is an illustrative response excerpt; normalized
data, retrieved policy IDs and full audit details are omitted for brevity:

```json
{
  "verdict": "BLOCK",
  "justification": "Phone must normalize to Sri Lanka country code +94 followed by exactly 9 digits; foreign country codes are blocked.",
  "failed_policies": ["EMP-REG-004"],
  "failed_fields": ["phone"],
  "findings": [
    {
      "verdict": "BLOCK",
      "policy_id": "EMP-REG-004",
      "field": "phone",
      "reason": "Phone must normalize to Sri Lanka country code +94 followed by exactly 9 digits; foreign country codes are blocked."
    }
  ],
  "can_create": false
}
```

Other missing evidence or violations can add more findings. A clear BLOCK takes
precedence over ESCALATE. Field reasons may come from deterministic checks or
the grounded policy judge; the frontend should display the returned findings.

## Example backend call (JavaScript)

The `payload` argument must be assembled on the backend as described above. This
function returns the decision; it never performs the ERP create-user operation.

```javascript
async function validateEmployee(payload) {
  const baseUrl = process.env.POLICY_GATE_URL?.replace(/\/$/, "");
  const apiKey = process.env.POLICY_GATE_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("Policy gate configuration is missing");

  const response = await fetch(
    `${baseUrl}/api/policy/employee-registration/validate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000),
    }
  );
  if (!response.ok) {
    throw new Error(`Policy validation failed: HTTP ${response.status}`);
  }
  const result = await response.json();
  if (!result || !["ALLOW", "BLOCK", "ESCALATE"].includes(result.verdict)) {
    throw new Error("Invalid policy validation response");
  }
  const allowed = result.verdict === "ALLOW" &&
    result.can_create === true && result.audit?.recorded === true;
  return { allowed, result };
}
```

Any thrown exception must stop creation. The caller uses `allowed` to enforce
the gate and displays `result.justification` / `result.findings` to the user.

- **ALLOW:** The backend may continue with `normalized_employee` for this exact
  requester/submission. Enforce uniqueness again atomically during ERP creation.
- **BLOCK:** Keep the entered values, display the reasons, allow correction, and
  validate the corrected submission again.
- **ESCALATE:** Stop creation and send for human verification. This API has no
  manual override endpoint.

Record `audit.audit_id` with the main system's request. A changed form or requester
requires validation again. Do not let the model skip this call or infer approval
from explanation text. The main system remains responsible for preventing duplicate
ERP writes when requests are retried.

## HTTP errors

| Status | Meaning and action |
|---|---|
| 401 | Missing/wrong X-API-Key; fix backend credentials |
| 422 | Invalid request shape/type/unknown property; inspect the JSON `detail` |
| 503 | Gate authentication is not configured; contact deployment owner |
| 5xx, timeout or malformed response | Validation is incomplete; stop creation |

Omitted/empty employee values are normally handled as policy findings, while
invalid JSON structure or types return HTTP 422. Missing duplicate evidence must
never be replaced with fabricated no-match results just to obtain ALLOW.

## Compatibility

`POST /api/policy/evaluate` is an alias for this same registration JSON contract.
The former finance `prompt`, `actor`, `context`, `decision: deny`, and
`allow_with_conditions` shapes are historical. The other developer should use the
explicit registration endpoint and uppercase verdicts shown here.

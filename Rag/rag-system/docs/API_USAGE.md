# API Usage — ERP Finance Policy Gate

Decides whether a finance request is permitted and returns the verdict. Never
executes anything itself.

- `POST /api/policy/evaluate` — is this action allowed?
- `POST /api/assist` — read-only lookups (plans tool calls, or answers)

## Auth

All endpoints except `/health` need:

```
X-API-Key: <your-api-key>
```

Missing/wrong key → `401`.

## Base URL

azure base url

---

## `POST /api/policy/evaluate`

Request:

```json
{
  "prompt": "release payment for invoice INV-8842",
  "actor": {"user_id": "U-1001", "role": "finance_manager", "department": "finance"},
  "context": {"amount": 1450000, "currency": "LKR"}
}
```

- `actor.role` must come from your authenticated session, never the prompt — every check is decided against it.
- `context` = facts you already know (e.g. amount). Anything missing comes back as a condition, never assumed true.

Response:

```json
{
  "request_id": "a1b2c3...",
  "decision": "allow_with_conditions",
  "reason": "Payment exceeds the single-approver threshold; dual authorization required.",
  "action": {"name": "release_payment", "parameters": {"invoice_id": "INV-8842", "amount": 1450000}},
  "conditions": [
    {"type": "threshold", "field": "amount", "operator": "<=", "value": 1000000, "satisfied": false}
  ],
  "citations": [{"policy_id": "FIN-PAY-2026-003", "section": "2", "quote": "..."}]
}
```

`decision`: `allow` / `allow_with_conditions` (execute only once every `condition` checks out) / `deny` / `review` / `answer`. Never treat `deny` or `review` as "retry with different wording."

## `GET /api/policy/actions`

Lists every action the gate recognizes — build your execution mapping from
this, not hardcoded names.

```bash
curl https://<host>/api/policy/actions -H 'X-API-Key: <your-api-key>'
```

| Action | Flow | Risk |
|---|---|---|
| `approve_invoice` | out | high |
| `approve_purchase_order` | out | high |
| `issue_credit_note` | neutral | high |
| `release_payment` | out | critical |
| `update_vendor_bank_details` | out | critical |
| `approve_travel_claim` | out | medium |
| `reimburse_expense` | out | high |
| `post_journal_entry` | neutral | high |
| `approve_budget_transfer` | neutral | medium |
| `view_ledger_entry` | neutral | medium |

---

## `POST /api/assist`

Read-only. Send a prompt + the tools you're willing to run; get a plan, an
answer, or a refusal. Stateless — resend history each turn.

**Turn 1:**

```json
{
  "prompt": "what is our cash position as of 2026-08-27?",
  "actor": {"user_id": "U-3001", "role": "finance_manager"},
  "tools": [{
    "name": "get_cash_position",
    "kind": "read",
    "description": "Cash balance as of a given date.",
    "input_schema": {"type": "object", "properties": {"as_of": {"type": "string"}}, "required": ["as_of"]}
  }]
}
```

→ `{"status": "needs_tools", "tool_calls": [{"id": "tc_1", "name": "get_cash_position", "arguments": {"as_of": "2026-08-27"}}]}`

**Turn 2** — run the tool yourself, send the result back:

```json
{
  "prompt": "what is our cash position as of 2026-08-27?",
  "actor": {"user_id": "U-3001", "role": "finance_manager"},
  "tools": [{"name": "get_cash_position", "kind": "read", "description": "...", "input_schema": {...}}],
  "history": [{
    "tool_calls": [{"id": "tc_1", "name": "get_cash_position", "arguments": {"as_of": "2026-08-27"}}],
    "tool_results": [{"id": "tc_1", "ok": true, "data": {"cash": 48200000}}]
  }]
}
```

→ `{"status": "final", "answer": "Cash position is LKR 48,200,000.", "used": ["tc_1"]}`

Notes:
- `tools[].kind` must be `"read"` — a `"write"` tool (or missing `kind`) is dropped silently.
- `status`: `needs_tools` (run the calls, resend) / `final` (`answer` grounded in `used`) / `refused` (don't retry).
- A mutating request (e.g. "approve invoice 8842") is refused here, pointing you to `/api/policy/evaluate`.
- `user_id`/`department`/`cost_center` arguments are overwritten from `actor` — the prompt can't widen its own scope.

---

## `GET /health` — no auth

```bash
curl https://<host>/health
```

`status: degraded` or `policy_chunks: 0` → corpus isn't loaded; every request will deny.

## MCP — `/mcp`

Same auth header, same decision as `POST /api/policy/evaluate`, exposed as tool `check_policy(prompt, actor, context)`.

```json
{"mcpServers": {"policy-gate": {"url": "https://<host>/mcp", "headers": {"X-API-Key": "<your-api-key>"}}}}
```

Convenience only — not enforcement. Your code must still call `/api/policy/evaluate` directly before any write; an agent can choose not to call the MCP tool.

## Errors

- `401` — missing/invalid key
- `422` — bad request body
- `500` — shouldn't happen; failures normally come back as `deny`/`refused`, not an error

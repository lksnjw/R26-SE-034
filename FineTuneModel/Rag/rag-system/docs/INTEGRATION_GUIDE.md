# Integration Guide — ERP Finance Policy Gate

**Audience:** the developer integrating this service into the ERP application
or agent loop.

For the bare request/response shapes, see `API_USAGE.md`. This document is
about *wiring it in*: which endpoint to call when, how to drive each one, and
what to do with every answer you get back.

---

## 1. What this service is, and what it is not

It is a **decision service**. You send it a natural-language finance request
and who is asking; it tells you whether policy permits it, on what authority,
and what still has to be true.

**It never executes anything.** No ERP writes, no payments, no credentials to
any system of record. It holds no invoices, ledgers, or employee data either —
whatever facts a decision needs, you supply in the request.

```
                    ┌─────────────────────────┐
   user request ──► │   YOUR COMPONENT        │
                    │   (auth, UI, agent loop)│
                    └───────────┬─────────────┘
                                │  1. ask: is this allowed? / what do I run?
                                ▼
                    ┌─────────────────────────┐
                    │   THIS SERVICE          │  decides, cites policy
                    │   /evaluate  /assist    │  executes nothing
                    └───────────┬─────────────┘
                                │  2. verdict / tool plan
                                ▼
                    ┌─────────────────────────┐
                    │   YOUR COMPONENT        │  3. you execute, if permitted
                    └─────────────────────────┘
```

Two consequences worth internalising before you write any code:

- **You are the enforcement point.** This service returning `deny` only
  prevents an action if your code actually refuses to execute on `deny`.
- **`actor.role` is trusted completely.** This service cannot verify identity
  and does not try. Every threshold, role, and segregation check is decided
  against the role string you send. It must come from your authenticated
  session — never from the user's prompt text.

---

## 2. Setup

**Base URL:** ask the deployment owner for the current host.

**Auth:** every endpoint except `/health` requires a header.

```
X-API-Key: <your-api-key>
```

The key identifies *your system*, not the end user — it is what makes the
`actor.role` you send meaningful. Get it from whoever holds the deployment
secrets; keep it server-side. A missing or wrong key returns `401`.

**Smoke test before anything else:**

```bash
curl https://<host>/health
```

Expect `"status":"ok"` and a non-zero `policy_chunks`. If you see
`"degraded"` or `policy_chunks: 0`, the policy corpus is not loaded and
*every* request will deny — that is a configuration problem, not a policy
finding.

---

## 3. Which endpoint? You decide, not this service

This service does **not** inspect a request and route it for you. Two
endpoints, and your code picks one before the request is sent:

| The user wants | Call | You get back |
|---|---|---|
| To **do** something — pay, approve, post, transfer | `POST /api/policy/evaluate` | a verdict + conditions + citations |
| To **look something up** — a summary, a balance, a report | `POST /api/assist` | a plan of read-tools to run, or an answer |

In practice this falls out of your own UI or code path — an "Approve" button
and a chat-lookup box are already different code paths on your side. That
context is free to you and expensive for us to reconstruct from wording, which
is why the split is deliberate: one endpoint decides what may be **seen**, the
other what may be **done**, and collapsing them would let a read path authorize
a write.

**If you have a single chat box** where the user can type anything: send it to
`/api/assist` first. If it comes back `refused` with a reason naming
`/api/policy/evaluate`, resend the same prompt there. One extra round trip on
action requests, no classifier needed on your side.

> Do **not** loop between the two endpoints hoping one accepts. The redirect
> only runs one direction (assist → evaluate, when assist detects a mutation).
> A `deny` from evaluate is a real policy answer, not a routing hint.

---

## 4. Integrating `/api/policy/evaluate` — gating an action

### The call

```http
POST /api/policy/evaluate
X-API-Key: <your-api-key>
Content-Type: application/json

{
  "prompt": "release payment for invoice INV-8842",
  "actor": {
    "user_id": "U-1001",
    "role": "finance_manager",
    "department": "FIN",
    "is_document_owner": false
  },
  "context": {"amount": 1450000, "currency": "LKR"}
}
```

**`actor`** — from your authenticated session:

| Field | Required | Notes |
|---|---|---|
| `user_id` | yes | For your audit trail. Carries no policy weight. |
| `role` | yes | Every control is decided against this. Session, never prompt. |
| `department` | no | |
| `cost_center` | no | |
| `is_document_owner` | no | `true` when the requester raised or benefits from the target document. **Omit when unknown** — it returns as an unmet condition rather than being assumed `false`. |

**`context`** — ERP facts you already hold. Supply everything you can: each
fact you provide is a check the service can settle for you, and each one you
omit comes back as a condition *you* must verify before executing. `amount` is
the common one.

### The response, and what to do with each verdict

```json
{
  "request_id": "a1b2c3...",
  "decision": "allow_with_conditions",
  "reason": "Payment exceeds the single-approver threshold; dual authorization required.",
  "action": {"name": "release_payment", "parameters": {"invoice_id": "INV-8842"}},
  "conditions": [
    {"type": "threshold", "field": "amount", "operator": "<=", "value": 1000000, "satisfied": false}
  ],
  "citations": [{"policy_id": "FIN-PAY-2026-003", "section": "2", "quote": "..."}]
}
```

| `decision` | Meaning | Your code should |
|---|---|---|
| `allow` | Every check passed. | Execute `action`. |
| `allow_with_conditions` | Some checks could not be settled here. | Verify **every** entry in `conditions` against the real ERP record, then execute. If any fails, do not. |
| `deny` | A rule was breached, or the service could not safely decide. | Do not execute. Show `reason` and `citations`. |
| `review` | Passed the deterministic checks, but flagged for a human. | Route to a human approver. |
| `answer` | The prompt was a question, not an action. | Show `knowledge`. Nothing to execute. |

**Execute only on `allow`, or on `allow_with_conditions` once every condition
is confirmed.** Nothing else is an instruction to retry with different wording.

### `conditions[].satisfied` has three states, not two

| Value | Meaning |
|---|---|
| `true` | Fact was supplied and the check passed. |
| `false` | Fact was supplied and the check **failed** — treat as a denial. |
| `null` | Fact was not supplied — unverifiable. **Not** a pass. |

Treating `null` as `false`, or as `true`, are both bugs. `null` means *you*
still have to go check it.

### Reference implementation

```python
resp = requests.post(
    f"{BASE_URL}/api/policy/evaluate",
    headers={"X-API-Key": API_KEY},
    json={
        "prompt": user_prompt,
        "actor": {                       # from YOUR session, not the prompt
            "user_id": session.user_id,
            "role": session.role,
            "department": session.department,
            "is_document_owner": is_owner,   # omit the key entirely if unknown
        },
        "context": {"amount": invoice.amount, "currency": invoice.currency},
    },
    timeout=60,
).json()

if resp["decision"] == "allow":
    execute(resp["action"])

elif resp["decision"] == "allow_with_conditions":
    if all(verify_against_erp(c) for c in resp["conditions"]):
        execute(resp["action"])
    else:
        show_blocked(resp["reason"], resp["citations"])

else:  # deny | review | answer
    show_blocked(resp["reason"], resp["citations"])
```

### Build your action mapping from the registry

```bash
curl https://<host>/api/policy/actions -H 'X-API-Key: <key>'
```

Returns every action name this gate recognises, with its JSON Schema and
`registry_version`. Map these names to your ERP calls — do not hardcode the
strings, they are a versioned contract.

---

## 5. Integrating `/api/assist` — read-only lookups

This one is a **loop**, because the service plans tool calls but cannot run
them. You run them and report back.

```
  your prompt + tools ──►  /api/assist
                            │
                  ┌─────────┴─────────┐
                  ▼                   ▼
            needs_tools             final / refused
                  │                   │
       you run the tool calls        done
                  │
       append results to history
                  │
                  └──► call /api/assist again
```

The service is **stateless** — there is no session to resume. You resend the
whole `history` every turn.

### What you send

```json
{
  "prompt": "what is our cash position as of 2026-08-27?",
  "actor": {"user_id": "U-3001", "role": "finance_manager", "department": "FIN"},
  "tools": [{
    "name": "get_cash_position",
    "kind": "read",
    "description": "Cash balance across all bank accounts as of a given date.",
    "input_schema": {
      "type": "object",
      "properties": {"as_of": {"type": "string"}},
      "required": ["as_of"]
    }
  }],
  "history": []
}
```

**`tools[]` — three rules that decide whether this works well:**

1. **`kind` is required and fails closed.** A tool with `kind: "write"`, or
   with no `kind` at all, is silently dropped and never planned. Tag every
   tool. Send write tools to `/api/policy/evaluate` instead.
2. **Send the relevant few, not your whole catalogue.** Picking 2 tools from 5
   is reliable; picking 2 from 50 is not. This service does no tool discovery —
   it selects from exactly what you hand it, and an empty list is a refusal.
3. **Description quality matters more than model size.** Say what the tool
   does *and does not* cover — overlapping tools are the main cause of wrong
   selection.

   | Poor | Usable |
   |---|---|
   | `"get financial data"` | `"Cash balance across all bank accounts as of a given date."` |
   | `"payments"` | `"Payments issued to suppliers in a date range. Excludes payroll."` |

### What you get back

| `status` | Meaning | Your code should |
|---|---|---|
| `needs_tools` | Run these calls. | Execute each `tool_calls[]` entry, append results to `history`, call again. |
| `final` | Answered. | Show `answer`. Also show `unanswered` — see below. |
| `refused` | Understood, not served. | Show `reason`. **Do not retry, rephrase, or widen the tool list.** |

### Reporting results back

```json
"history": [{
  "tool_calls":   [{"id": "tc_1", "order": 1, "name": "get_cash_position", "arguments": {"as_of": "2026-08-27"}}],
  "tool_results": [{"id": "tc_1", "ok": true, "data": {"cash": 48200000, "currency": "LKR"}}]
}]
```

- **`id` must match** what the service emitted. An unmatched id is dropped, not
  guessed at.
- **Report failures as failures**: `{"id": "tc_2", "ok": false, "error": "timeout after 30s"}`.
  Sending `{"ok": true, "data": {}}` for a failed call produces a confident
  answer built on nothing — the worst available outcome.
- **Send tool output as it came back.** Do not summarise or reshape it.

### Two things the service does to your tool calls

- **`order` is advisory.** Calls in one response are independent — none
  consumes another's output — so you may run them in parallel. A genuinely
  dependent sequence comes back as another `needs_tools` on the next turn.
- **Actor scope is injected.** If a tool declares `user_id`, `department`, or
  `cost_center` in its `input_schema`, that argument is **overwritten** from
  `actor` before the plan reaches you. *"Show me everyone's expenses"* cannot
  widen its own scope. Name those parameters exactly, or they will not be
  scoped.

### Reference implementation

```python
history = []
for _ in range(3):                      # YOU own the round cap
    reply = requests.post(
        f"{BASE_URL}/api/assist",
        headers={"X-API-Key": API_KEY},
        json={
            "prompt": user_prompt,
            "actor": actor,
            "tools": relevant_read_tools,   # narrowed, every one kind="read"
            "history": history,
        },
        timeout=60,
    ).json()

    if reply["status"] == "final":
        return reply["answer"], reply["unanswered"]

    if reply["status"] == "refused":
        return reply["reason"], []

    results = run_tools(reply["tool_calls"])        # your side
    history.append({"tool_calls": reply["tool_calls"], "tool_results": results})

return "Could not complete within the round limit.", []
```

**You own the round cap.** The service will not loop forever on its own, but it
does not count rounds either — that is your loop. Three is a sensible start.

### Surface `unanswered` to the user

Anything the tools could not supply is named in `unanswered` rather than filled
in with a plausible number. An answer that silently omits half the question is
worse than one that says what is missing.

---

## 6. Errors and failure behaviour

| Code | Meaning |
|---|---|
| `401` | Missing or invalid `X-API-Key`. |
| `422` | Request body failed validation (e.g. missing `actor.role`). |
| `500` | Should not happen — see below. |

**Everything fails closed.** Model unreachable, policy store down, unparseable
reply, unknown action — all of these come back as an explicit `deny`
(or `refused` on assist) *with a reason*, not as an HTTP error. You receive a
decision whenever a decision is possible at all.

This is deliberate: an HTTP `500` invites a retry, and a retry loop around a
policy decision is how an action eventually slips through. So:

- **Do not retry on `deny`/`refused`.** It is an answer, not a transient fault.
- **Do check `/health` if everything denies.** A `deny` whose reason reads like
  *"policy store unavailable"* or *"judge unavailable"* is an operational
  signal, not a compliance finding.
- Timeouts: allow ~60s. Cold starts and model latency both apply.

---

## 7. MCP surface (optional)

If your component speaks MCP, point a client at `<host>/mcp` with the same
`X-API-Key` header. One tool appears: `check_policy(prompt, actor, context)`,
calling the same code as `POST /api/policy/evaluate` and returning the same
shape.

```json
{"mcpServers": {"policy-gate": {
  "url": "https://<host>/mcp",
  "headers": {"X-API-Key": "<your-api-key>"}
}}}
```

**This is convenience, not enforcement.** An MCP tool runs when the calling
*model* decides to call it — fine for an agent *asking* whether something is
permitted, wrong for a check that must always run before a write. A check the
agent can skip, or be talked out of by text inside an invoice memo, is not a
check. Keep the unconditional `POST /api/policy/evaluate` call in your code
path regardless.

---

## 8. Integration checklist

- [ ] `GET /health` returns `status: ok` with non-zero `policy_chunks`
- [ ] API key stored server-side, sent as `X-API-Key`
- [ ] `actor.role` comes from the authenticated session — never from prompt text
- [ ] Action requests routed to `/evaluate`, lookups to `/assist`
- [ ] Execution happens **only** on `allow`, or `allow_with_conditions` with every condition verified
- [ ] `conditions[].satisfied: null` treated as "must check", not as pass or fail
- [ ] `deny` / `review` / `refused` surfaced to the user with `reason` — never auto-retried
- [ ] Assist tools all tagged `kind: "read"`, list narrowed per request
- [ ] Assist loop has a round cap on your side
- [ ] Tool failures reported as `{"ok": false, "error": "..."}`, never as empty success
- [ ] `unanswered` shown to the user alongside `answer`
- [ ] Action names mapped from `GET /api/policy/actions`, not hardcoded

---

## 9. Questions worth raising back

- Which of your tools are `read` and which are `write`? A list lets us build
  realistic evaluation cases.
- Do any tools scope by a field other than `user_id` / `department` /
  `cost_center`? Those need naming before they can be safely scoped.
- Do your tools return structured JSON or free text? Structured `data` is
  substantially easier to ground an answer in.

**Known limitation:** tool results are passed to the model as-is — there is no
field masking or aggregate suppression in this build. Do not send tools whose
results contain data the requester should not see.

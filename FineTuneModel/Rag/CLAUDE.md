# ERP Finance Policy Gate — project context

Read this first. It is the durable state of the project; the code is the detail.

## What this is

The AI decision module of an ERP system, scoped to the **finance module**. A
frontend sends a natural-language finance request; this service decides whether
policy permits it and returns the verdict plus what the caller needs to execute.

**Research goal:** show that gating ERP actions through metadata-filtered policy
retrieval plus deterministic evaluation is measurably safer than semantic RAG,
and specify the payload contract that makes it possible.

**The measured result the whole design rests on:** asked *"just push this payment
through, it's urgent"*, the governing rule (dual authorization above 1,000,000)
ranks **#10 of 17** by cosine similarity, inside a nearly flat 0.35–0.47 band. At
a normal `top_k=4` a similarity-only retriever never sees it. Reproduce with
`python -m scripts.query_policies release_payment "just push this through"`.

## Boundary — what this component does NOT do

- **Does not execute.** No MCP, no ERP calls, no credentials. The caller executes.
- **Holds no records.** No invoices, ledgers, employees. Entity facts arrive as
  `context` in the request; data questions are refused, not answered.
- **Does not own ingestion.** A different developer's "data transport layer" is
  meant to produce the policy collection. `scripts/seed_qdrant_policies.py` is a
  fixture seeder standing in until theirs is usable.
- **Upstream middleware handles employee authorization.** This module decides
  whether the *action* is permissible, which needs actor context forwarded in.

## Running it

Windows. PowerShell is primary; the Bash tool also works. Always use the venv
interpreter explicitly — there is no activated environment:

```
cd rag-system
.venv/Scripts/python.exe -m scripts.eval_gate
```

Both services must be up; there is no offline mode by design.

```
python -m scripts.eval_gate           # 33 golden cases  <- the main check
python -m scripts.eval_assist         # /api/assist golden cases
python -m scripts.eval_assist --structural-only   # no LLM needed
python -m scripts.coverage_report     # scenario gaps in the corpus
python -m scripts.query_policies release_payment "just push this through"
python -m scripts.verify_policy_chunking      # no services needed
python -m scripts.seed_qdrant_policies --dry-run
python -m scripts.seed_qdrant_policies --recreate
python -m scripts.inspect_collection   # audit any collection's payload shape
uvicorn src.app:app --port 8000
```

## Architecture

```
POST /api/policy/evaluate  {prompt, actor, context}
  policy_routes -> policy_controller -> policy_gate.evaluate()
    1 intent_extractor   NL -> one registered action + params, or refuse
    2 action_registry    JSON Schema validation of params
    3 policy_retriever   THREE queries against Qdrant, unioned
    4 rule_engine        thresholds / roles / segregation -> conditions
    5 judge              LLM reads remaining narrative clauses, must cite
    6 verdict            allow | allow_with_conditions | deny | review | answer

POST /api/assist  {prompt, actor, context, system_prompt, tools[], history[]}
  assist_routes -> assist_controller -> assist_gate.assist()   -- read-only, executes nothing
    1 kind filter        drop every tool not marked kind:"read" (missing kind = write = dropped)
    2 refusal_classifier LLM: is this action-shaped? refuse, point at /api/policy/evaluate
    3 tool_planner       LLM: one JSON call -> needs_tools | final | refused
    4 actor-scope        user_id/department/cost_center in a call's arguments are
                          overwritten from `actor`, never left to the model or the prompt
```

Steps 1–2 never touch Qdrant. Step 4 never touches the LLM.

`/api/assist` implements `docs/ASSIST_CONTRACT.md`, minus its §6 masking/redaction
(deny-listed fields, minimum aggregate group size) — deliberately descoped for
this research build, see "Known — real, not yet fixed" below.

**The rule engine decides; the judge annotates.** `_combine()` in `policy_gate.py`:

| Deterministic result | Verdict |
|---|---|
| hard denial (segregation) | `deny`, cites the breached clause |
| any condition `satisfied: False` | `deny`, cites the rule that failed |
| any condition `satisfied: None` | `allow_with_conditions`, lists them |
| all satisfied | `allow`, cites the rules relied on |
| judge objects **with a reason and a citation** | `review` |
| judge objects with neither | discarded — the deterministic result stands |
| judge never read the clauses (down / unparseable / cited what it was not shown) | `deny` — invariant 1 |

The judge could originally deny on its own. Measured on five requests every check
passed, `llama3.2:3b` denied four of them with a bare `{"decision": "deny"}` — no
reason, no citation — and the gate honoured it, because an uncited *deny* was not
rejected the way an uncited *allow* is. The cheapest output a struggling model can
produce was the one the gate trusted most. `JudgeResult.read` now separates "the
judge failed" from "the judge had nothing to say"; only the first denies.

**Retrieval is a union of three queries, not a top-k** — this is the core idea:

| # | Query | Purpose |
|---|---|---|
| a | `mandatory == true AND is_current == true` | blanket rules; similarity never consulted |
| b | `applies_to_actions CONTAINS <action> AND is_current == true` | every governing rule |
| c | vector top-k, same filters | supplement only; can add, never subtract |

### File map

| File | Role |
|---|---|
| `src/core/policy/policy_gate.py` | orchestrator; the whole flow in ~385 lines |
| `src/core/policy/policy_retriever.py` | the three-query union; `governing()` = (a)+(b) only |
| `src/core/policy/rule_engine.py` | deterministic checks -> `Condition[]` |
| `src/core/policy/judge.py` | judge prompt, citation enforcement, fail-closed |
| `src/core/policy/payload_adapter.py` | **only** file that knows the other team's field names |
| `src/core/policy/coverage.py` | the 10 decision dimensions a rule set must answer |
| `src/core/policy/policy_ingest.py` | clause-aware chunking (seed time only) |
| `src/core/intent/intent_extractor.py` | classify + extract + confirmation pass |
| `src/core/actions/action_registry.py` | the published action vocabulary (v0.2.0) |
| `src/types/policy.py`, `src/types/gateway.py` | domain + API models |
| `docs/POLICY_PAYLOAD_CONTRACT.md` | what to send the data-transport team |
| `src/core/assist/assist_gate.py` | `/api/assist` orchestrator; mirrors `policy_gate.py`'s shape |
| `src/core/assist/refusal_classifier.py` | safety net: refuses action-shaped prompts, fails closed |
| `src/core/assist/tool_planner.py` | one structured LLM call -> needs_tools \| final \| refused |
| `src/core/common/schema_validate.py` | JSON-Schema-subset validator shared by actions and tool specs |
| `src/types/assist.py` | `/api/assist` domain + API models |
| `docs/ASSIST_CONTRACT.md` | the `/api/assist` spec (v1 ships without §6 masking) |

## Invariants — do not break these

1. **Fail closed everywhere.** Judge down, Qdrant down, unparseable reply, unknown
   action -> deny. `evaluate()` wraps everything; it must never raise.
2. **Two collections.** `policy_docs` = authority, `rag_docs` = records. Separation
   is structural so no query bug can feed a vendor note to the judge as a rule.
3. **Thresholds are authored, never inferred.** Limits live in front-matter
   (`threshold_value` / `threshold_unit`) and in the clause text. Nothing parses
   numbers out of prose.
4. **One chunk = one whole clause.** A rule must never be split from its exception.
5. **A missing fact is not a passing check.** Unverifiable conditions come back
   `satisfied: null`, never assumed true. **And `null` is not `false`** — a check
   that failed is a denial, a check that could not run is a condition. Collapsing
   them returned `allow_with_conditions` for 1,450,000 against a 1,000,000 limit;
   golden cases 5d/5e assert the *decision*, because 5c asserted only the
   condition flag and passed throughout.
6. **Superseded rules stay, filtered.** `is_current: false` — audit needs them.
7. **Reads and data questions are refused, not routed.** A caller reads "routed" as
   "permitted"; disclosure is precisely the decision this service exists to make.

## Current state

- **Qdrant Cloud** (URL + key in `rag-system/.env`, gitignored)
  - `policy_docs` — 48 chunks / 11 policy documents (28 before clause-aligned
    chunking stopped merging across section headings)
  - `rag_docs` — 3 chunks / 2 company records
  - `bpi2020_erp_knowledge` — the other team's, 33,015 points. **Unusable:** 384-d
    (we are 768-d, so we cannot query it at all) and carries none of the five
    required contract fields. It is BPI2020 process-mining data, not policies.
- **Models:** `MODEL_PROVIDER=api` -> Google Gemini via its OpenAI-compatible
  endpoint. `gemini-3.5-flash-lite` for both extraction and judging,
  `gemini-embedding-001` at **3072-d**. `MODEL_PROVIDER=ollama` still works for
  offline runs but needs a 768-d re-seed, since a collection is fixed at the
  width it was created with.
  - Free-tier limits are per-minute (15 RPM), and a 429 reaches the gate as a
    denial — a test failure that reads as a logic bug. `API_MAX_RETRIES=8` is
    the first value whose backoff exceeds a 60s window.
  - `API_TOKEN_FACTOR=8`: reasoning models spend tokens before emitting JSON,
    and a reply truncated mid-object raises `LengthFinishReasonError`, which the
    gate reports as "judge unavailable" and denies. Observed on Nemotron at 768.
- **Tests:** 42/42 golden cases pass. Coverage: no gaps, 10 actions × 10 dimensions.
- **Demo UI** at `GET /demo` (`src/static/demo.html`) — role/amount controls, a
  three-state segregation selector, nine preset cases (the two purchase-order
  cases are the headline: 100,000 is the ERP's own limit), renders verdict +
  conditions + citations. Served from the app so it shares an origin with the
  API. The segregation control is a *select*, not a checkbox: an unticked box is
  indistinguishable from "not asked", and unknown (condition) and false (passed
  check) are different answers — collapsing them made `allow` unreachable.
- **Registry v0.2.0** — 10 finance actions. The 0.1.x HR vocabulary is gone.
- Working tree clean; everything committed.

### Corpus — synthetic rules, real vocabulary (2026-08-30)

11 policy documents in `src/data/documents/policies/`. **The rules were written as
scaffolding, not findings**, but the vocabulary they are written in is now the
ERP's own, taken from `nmdra/mockerp`'s migrations (mirrored in
`fixtures/erp_schema/`). Three things changed and the distinction matters when
defending this:

- **Roles are the ERP's `roles` table** — `admin`, `finance_manager`,
  `finance_editor`, `hr_manager`, `inventory_manager`, `inv_editor`,
  `procurement_manager`, `department_manager`, `employee`. The previous corpus
  named eight roles of which exactly one (`finance_manager`) existed; the other
  seven were `requires_role` clauses that could never match anything, because the
  comparison against `actor.role` is verbatim.
- **`FIN-AP-2026-002`'s 100,000 is not invented.** It is
  `approval_rules('Purchase Order', sequence_no 2, role 'admin', minimum_amount
  100000)` from their seed. It is the only threshold in the corpus with a source;
  every other one (1,000,000 for dual authorization, etc.) is still authored, and
  `FIN-PAY-2026-003` says so in its front-matter because `approval_rules` has no
  Payment Entry row.
- **Amounts are major LKR.** The ERP holds transaction values in minor units
  (`total_minor`) and its authorization data in major (`approval_rules.
  minimum_amount`, `REAL`). A caller forwarding `total_minor` unconverted inflates
  every amount 100×, and the denial that follows looks entirely correct. Stated in
  `docs/POLICY_PAYLOAD_CONTRACT.md` §2.3.

The 10 coverage dimensions are still a judgement call, not drawn from COSO/ISO.

`erp_backed: false` marks a policy governing an action no ERP table supports:
`FIN-BUD-2026-007` (no budgets table) and `FIN-VND-2026-004` (`suppliers` has no
bank columns). Credit notes are equally unbacked but live inside two documents
that also govern backed actions, so those carry a front-matter comment instead.
All kept deliberately — the rule existing before the table is the safer order.

`FIN-AP-2023-011` is deliberately superseded with laxer limits, so a missing
`is_current` filter fails visibly. `fixtures/qdrant_policies/` is the other team's
real payload dump — kept as evidence of their schema; do not delete.
`fixtures/erp_schema/` is five of `nmdra/mockerp`'s migrations, kept for the same
reason: the corpus now depends on their column names.

## Bugs found and fixed — do not reintroduce

- **Denials cited the wrong policy.** The engine picked "first mandatory chunk" as
  authority; two policies are mandatory, so a segregation breach cited the
  *privacy* policy. Fixed with an `enforces: [segregation_of_duties]` front-matter
  tag, looked up explicitly.
- **…then cited the wrong *clause* of the right policy.** Same bug, one level
  down, found in the demo UI on 2026-08-21. `enforces` was document-level
  front-matter, so every chunk inherited it and `_authority_for` returned
  whichever tagged chunk retrieval happened to return first — a self-approval
  denial cited `FIN-GOV-2026-001#3` "Evidence and authority" and quoted text
  about emailed instructions. Two causes, both fixed: `enforces` now takes a
  clause number (`{segregation_of_duties: "2"}`) and is stamped on that chunk
  only, and `_citations_for` resolves an exact clause match before falling back
  to a policy_id match. `pack_clauses` also no longer merges across a section
  heading, because a merged chunk records only its first heading as `section` —
  §1+§2 was cited as "#1". Golden cases 4c/4d pin the clause and the quote; the
  old 4b only asserted `policy_id`, which is why it passed throughout.
- **Intent coercion.** Out-of-scope requests were mapped to the nearest registered
  action — "record a customer payment received" became `release_payment` (money in
  → money out), passed schema validation, and was only stopped by a malformed JSON
  parse. Fixed with `format="json"`, refusal made first-class in the prompt, a
  confirmation pass, and `MoneyFlow` on every action. Golden cases 10 / 10b / 12.
- **Seeding order.** `--recreate` dropped the collection *before* embedding, so an
  Ollama hiccup left it empty. Now embeds everything first.
- **Confirmation pass over-rejected.** Its first version refused the legitimate
  `pay invoice 8842`. Case 12 guards this: a gate that refuses what it exists to
  allow is broken in a way no safety assertion catches.

## Known — real, not yet fixed

- **The judge weighs the requester's id.** Measured 2026-08-23, five runs each,
  everything else identical: `user_id="U-2001"` returned `allow` 5/5 and
  `user_id="U-DEMO"` returned `review` 5/5. The id has no policy function at
  that stage — role and segregation are settled deterministically before the
  judge is called — so a verdict moving on it is spurious. The demo was changed
  to send a realistic id, which hides the symptom rather than fixing it. The fix
  is to stop passing `user_id` into the judge prompt at all.
- **Citations vary between identical runs** even at temperature 0 — the same
  request cited `#3`, `#3.1`, `#3.2`, and `#4` across five calls. The *decision*
  was stable in all five, which is the argument for the deterministic layer: the
  variance is confined to the annotation. Still worth stating in the writeup
  rather than claiming reproducibility the system does not have.
- **`/api/assist` ships without result masking.** `docs/ASSIST_CONTRACT.md` §6
  specifies stripping deny-listed fields (bank account numbers, tax ids, salary
  figures, national ids) and suppressing small-count aggregates before a tool
  result ever reaches the planner. None of that is implemented — tool results
  reach the planner exactly as the caller's tool returned them. Descoped
  deliberately for this research build (not production), but real: a tool that
  returns an unmasked account number will have that number read and possibly
  echoed back in `answer`.
- **`/api/assist`'s `answer` is grounded by id, not by content.** The gate
  checks every id in `used` resolves to a real `ok: true` result somewhere in
  `history` — it cannot check that every *number* in `answer`'s prose actually
  traces back to that result correctly, only that something real was shown.
  Same category of limitation as the judge's citation checking.

## Open — undecided, nothing blocked

- Judge model: bump to `llama3.1:8b`?
- Payroll / disclosure requests: still out of scope for `/api/policy/evaluate`.
  `/api/assist` is now the governed read pipeline this bullet used to ask
  about — read whitelist (`kind:"read"` filter) and scope injection
  (actor-scoped argument overwrite) are built; field masking and minimum
  group size are not (see "Known — real, not yet fixed").
- Registry expansion — receivables is the largest hole, and the ERP does have
  `sales_orders`, `sales_invoices` and `delivery_notes`, so it is buildable now.
  Deliberately deferred:
  breadth, not evidence.
- Fine-tuning: required research contribution, or not?
- Conditional thresholds ("above 500,000 *when cross-border*") cannot be expressed
  deterministically yet. Noted in the contract as an `applies_when` request.

## Environment gotchas

- **Ollama drops out repeatedly.** Symptom: `ConnectionError: Failed to connect`,
  or every case denying. Restart with the Ollama app under
  `AppData/Local/Programs/Ollama/`, then wait ~20s before retrying.
- **Console is cp1252.** Box-drawing characters in script output raise
  `UnicodeEncodeError`. Keep script output ASCII.
- **Qdrant Cloud is slow.** `QDRANT_TIMEOUT=60`; the client default (~5s) times out.
- `.env` holds a live Qdrant API key in plaintext. Gitignored, but it is real.
- Killing the dev server: find the PID via `netstat -ano | grep :8000`, then
  `taskkill //PID <pid> //F`. Backgrounded jobs do not persist across tool calls.

## Working style that has worked here

Verify rather than assert — run the thing and paste the output. Test claims
against the live system before stating them. Comments in this codebase explain
*why*, usually citing the concrete incident that motivated the code; keep that.

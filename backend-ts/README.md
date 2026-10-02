# TypeScript backend port

The [Firestore rollback-readiness proof](../docs/FIRESTORE_ROLLBACK_READINESS_2026-10-08.md) adds a read-only exact-workspace-confirmed operator check. It accepts only the untouched revision-1 migration and atomically binds the loaded normalized head with the exact retained legacy document under current writer authority. The actual emulator proved readiness and then denial after one normalized post-cutover write. The command never changes routing; operational rollback remains external and unqualified.

The [Firestore disposable restore rehearsal](../docs/FIRESTORE_DISPOSABLE_RESTORE_REHEARSAL_2026-10-08.md) authenticates a retained artifact and can rebuild it only into a separately confirmed, different `restore_` quarantine. It never reads the live source or changes routing; exact state and transition identity are verified again by `restore-status`. Historical approvals/jobs remain evidence-only. The guarded emulator restored 483 records while the live source was unusable; same-target and wrong-confirmation cases failed. Cloud IAM/load, retention, routing/rollback and production qualification remain unfinished.

The [Firestore abandoned-staging recovery milestone](../docs/FIRESTORE_ABANDONED_STAGING_RECOVERY_2026-10-08.md) adds an explicit confirmation-gated `clear-staging` operator command. Current writer authority and a headless target are checked transactionally, active targets are preserved, manifests are removed before chunks, the legacy source is compared before/after, and a different reviewed cutover can retry. Verification passes **1,958 tests / 86 suites**, one configured-live-provider skip, typecheck, production build and the actual guarded Firestore Emulator abandon/clear/retry campaign. Cloud migration, routing/rollback and production qualification remain unfinished.

The [immutable node-level ERPBridge connection dispatch milestone](../docs/IMMUTABLE_NODE_CONNECTION_DISPATCH_2026-10-07.md) carries a strict `connection_id` from tool/agent authoring through immutable capability pins, read/collection/operation admission, workers, dynamic agent calls and read-back recovery. Composite connection/tool identities isolate duplicate tool IDs and every SDK entry rechecks its exact server-owned session and role map without primary fallback. Verification passes **1,859 tests / 75 suites**, one configured-live-provider skip, typecheck and production build. Live ERPBridge/provider/email qualification, cloud release and production security/accessibility/load/latency gates remain unfinished.

The [connection-scoped capability review milestone](../docs/CONNECTION_SCOPED_CAPABILITY_REVIEW_2026-10-07.md) routes discovery, catalog, explicit review and disable through one exact configured ERPBridge session. Catalog evidence is filtered by connection, cross-connection review/duplicate recovery is denied and public choices contain no endpoint, credential or private binding. Verification passes **1,859 tests / 75 suites**, one configured-live-provider skip, typecheck/build and the complete actual Firestore runtime campaign. Workflows remain primary-only until immutable node/publication/worker connection binding is complete.

The [multiple ERPBridge connection lifecycle milestone](../docs/MULTI_MCP_CONNECTION_LIFECYCLE_2026-10-07.md) adds one-to-eight strict backend-owned connection catalogs, environment secret references, exact primary designation, independently persisted revisioned lifecycle state, restart restore and one-sided rotation fencing. Settings can manage every configured connection, while all current workflow/chat/runtime dispatch remains limited to the primary connection. Verification passes **1,859 tests / 75 suites**, one configured-live-provider skip, typecheck/build and the complete actual Firestore runtime campaign. Per-node connection binding, live ERPBridge qualification and production release remain unfinished.

The [durable daily service-principal scheduling milestone](../docs/DURABLE_DAILY_SERVICE_PRINCIPAL_SCHEDULING_2026-10-06.md) replaces the inert legacy cron-edit path for supported reviewed sequential operations. Exact publication/timezone/local-time/service-principal/input revisions create deterministic durable occurrences; late work follows explicit `SKIP` or `FIRE_ONCE`; every effect still requires a fresh independent approval. A committed occurrence claim followed by lost acknowledgement restarts as one execution and one eventual synthetic dispatch. Verification passes **1,771 tests / 71 suites**, one configured-live-provider skip, typecheck/build and the actual guarded Firestore fault campaign. Arbitrary calendars, broader effects and live/cloud qualification remain unfinished.

The [separate linked recovery-execution milestone](../docs/SEPARATE_LINKED_OPERATION_RECOVERY_EXECUTION_2026-10-06.md) admits one exact immutable `NOT_APPLIED` recovery plan as a distinct currently validated workflow/execution. It creates new approval, intent and idempotency identities, requires fresh independent approval, and uses the normal one-use SDK boundary. Direct normal reruns of the generated workflow are denied. Post-COMMIT admission acknowledgement loss recovers the one linked execution, while the source execution remains byte-for-byte unchanged and `UNKNOWN`. Verification passes **1,766 tests / 71 suites**, one configured-live-provider skip, typecheck/build and the actual guarded Firestore admission/restart/approval/one-dispatch campaign. Broader effects, scheduling and live/cloud qualification remain unfinished.

The previous [immutable linked recovery-plan milestone](../docs/IMMUTABLE_LINKED_OPERATION_RECOVERY_PLAN_2026-10-06.md) lets the current source requester save one exact plan after independent query-backed `NOT_APPLIED` closure. The request supplies only source pins and an idempotency key; the server reconstructs the action. The normalized encrypted record carries no dispatch authority and preserves the source run/intent/node as closed and `UNKNOWN`. Verification passed **1,763 tests / 71 suites**, one configured-live-provider skip, typecheck/build and actual guarded Firestore plan ACK-loss/replay/restart. The newer milestone closes its separate-admission gate for the supported low-risk sequential profile.

The previous [reviewed query-backed resolution milestone](../docs/REVIEWED_QUERY_BACKED_OPERATION_RESOLUTION_2026-10-06.md) lets an independent `execution:reconcile` principal close an exact uncertain case from one saved settled `APPLIED`/`NOT_APPLIED` read-back. The request contains no client outcome; the server reconstructs and derives it from private immutable query evidence. Original intent/node provenance stays `UNKNOWN`, with no output, resend, resume or delivery claim. Verification passed **1,759 tests / 71 suites**, one configured-live-provider skip, typecheck/build and actual guarded Firestore ACK-loss/replay/restart; the complete synthetic browser path also passed. At that checkpoint, linked recovery remained unfinished; the newer milestone closes only the non-dispatch artifact gap.

The [readable workspace status-query integration](../docs/READABLE_OPERATION_STATUS_QUERY_WORKSPACE_2026-10-06.md) now consumes the durable APIs in selected-node canvas, full-run and minimum reconciliation surfaces. Public history/receipts carry exact execution/intent/node identity; `canCancel` is freshly derived per pending job, and recovery-only access never becomes query control. Backend verification passes **1,755 tests / 71 suites**, one configured-live-provider skip, typecheck/build and the actual demo Firestore runtime campaign. The browser never supplies query arguments, roles, results or classifications. Reviewed query-backed resolution/linked recovery and live ERP/cloud qualification remain unfinished.

Normal scoped status-query admission/history/cancellation and a separate durable governed read-only worker now save private exact fresh/correlated/settled evidence without changing the original uncertain action or resuming it. Full verification passes **1,754 tests / 71 suites**, one configured-live-provider skip, typecheck/build and actual demo Firestore normal query/restart/admission-intent-result ACK-loss checks. History after revocation/closure and late-answer/lease/heartbeat containment are covered. See [contracts, state semantics and remaining UI/recovery gates](../docs/DURABLE_OPERATION_STATUS_QUERIES_2026-10-06.md). This delivers backend jobs/APIs, not frontend query controls, reviewed resolution, linked recovery, delivery proof or live/cloud/full-project completion. Earlier paragraphs retain historical scope/counts.

Optional reviewed `operation_contract.readback` now pins an exact separately admitted low-risk read/output contract into normal operation publication semantics. Current publication/admission/worker checks deny target drift, and a pure evaluator requires bounded exact arguments plus fresh correlated settled structured evidence. Full verification passes **1,713 tests / 71 suites**, one configured-live-provider skip, typecheck/build; the complete actual demo Firestore campaign qualifies an explicit synthetic broker query without changing or resolving the original UNKNOWN run. This is not a durable read-back job, evidence ledger, HTTP/UI feature, linked recovery or delivery certificate. See [contracts and next normal-runtime gates](../docs/REVIEWED_OPERATION_READBACK_CONTRACTS_2026-10-06.md). Full G01–G66 remains unfinished; earlier paragraphs retain historical scope/counts.

Read-only `/api/settings/runtime-approval-policy` now exposes bounded current approval metadata under settings authority, without role grants or execution capability. Existing protected PATCH paths require current Platform Admin, eligible roles and exact base revision; persistence-ACK loss returns explicit 503/unconfirmed and stale resubmission conflicts after recovery. Full verification passes **1,644 tests / 70 suites**, one configured-live-provider skip, typecheck/build and actual demo Firestore policy activation ACK-loss/reload/restart checks. See [contracts, UI verification and remaining gates](../docs/RUNTIME_APPROVAL_POLICY_ADMINISTRATION_2026-10-06.md). The full product remains unfinished; older paragraphs retain their dated milestone scope.

Read-only `/api/execution-reviews` now discovers supported independent approvals and uncertain outcomes with current-role/policy scope, signed actor/authority/filter-bound pagination and every exact historical approval identity. Record-bound minimum links cannot reauthorize an old decision; denied authoritative storage returns 503 without stale task data. Full backend verification passes **1,636 tests / 70 suites**, one configured-live-provider skip, typecheck/build and actual demo Firestore multi-decision wait/restart/history/ownership checks. See [contracts, UI evidence and remaining full-goal gates](../docs/EXECUTION_REVIEW_INBOX_2026-10-06.md). Live ERP/cloud effects, scheduling, full multi-MCP administration and production latency remain unqualified.

Uncertain normal sequential operations now support explicit independent `execution:reconcile` review/decision, immutable private normalized external-evidence records, exact historical integrity/current-role checks and post-COMMIT decision recovery. `RECONCILED` closes the run by operator evidence, never by fabricated SDK success or automatic replay/resume. Full backend verification now passes 1,621 tests plus one configured-live-provider skip; actual demo Firestore decision loss/reload/replay/restart also passes. See [contracts, evidence and remaining recovery gates](../docs/OPERATOR_OUTCOME_RECONCILIATION_2026-10-06.md). Prior paragraphs describe dated milestones, not complete product support.

Normal reviewed sequential operations now have separate compilation/publication/admission, exact independent approval waits, scoped durable claims/intents, fresh resume, authentic one-use SDK permits and acknowledged contract-checked answers. Read-only brokers remain read-only; approval receipts and validator tokens alone cannot perform ERP effects. Actual Firestore restart/intent-ACK-loss and synthetic normal-route/browser checks pass. See [operation contracts, evidence and remaining full-goal gates](../docs/NORMAL_APPROVED_OPERATION_EXECUTION_2026-10-06.md); the foundation paragraph below describes the preceding milestone, not current operation-profile support. The complete project, structured effects/reconciliation/scheduling/admin and live ERP/cloud release are unfinished.

Exact runtime approval records now use protected scoped checkpoints, immutable transaction context, current independent-principal authority and once-only decision acknowledgement. Minimum review is available through the existing execution detail query; approval alone never resumes through a model. Normal workers do not produce these waits yet, the current producer binds a reviewed non-collection read checkpoint, and safe effect admission/outbox/resume/email/scheduling remain required. See [approval contracts, verification and next integration](../docs/EXACT_RUNTIME_APPROVAL_FOUNDATION_2026-10-06.md).

Structured canvas `moveNode` commands now preserve complete condition/collection/return subtrees, reject descendant/scope/no-op targets and use the existing current-role/revision/hash validator/history gates. Broken references stay intact in blocked drafts; moves never publish or run. See [structured placement and actual Firestore restart evidence](../docs/STRUCTURED_CANVAS_PLACEMENT_2026-10-06.md).

Saved undo/redo and full-draft restoration use immutable server version identities, current editor/revision/hash checks and revalidation. Normal commands, legacy YAML replacement and saved-version restoration share the history helper and invalidate run readiness. A lost save acknowledgment is reported as unconfirmed, never assumed unchanged or retried. See [saved history, actual Firestore restart/fault evidence and remaining goals](../docs/DRAFT_EDIT_HISTORY_AND_RECOVERY_2026-10-06.md).

Selected collection, condition and return chat edits use dedicated tools-free patch contracts; actions retain their own patch contract. Saved proposals and draft apply/readiness now include pure structural compiler validation. Exact explicit apply preserves unrelated nodes and creates a nonrunnable draft, never automatic publication/execution. See [collection-node contract, actual Firestore persistence evidence and remaining full-goal gates](../docs/COLLECTION_NODE_CHAT_AND_DRAFT_VALIDATION_2026-10-06.md).

This folder contains the isolated TypeScript backend. It listens on `:8081` by default, while the reference Go backend can continue listening on `:8080`. The TypeScript runtime does not import or start the Go backend.

## Run

Requirements: Node.js 22 or newer.

For a safe local presentation, start the explicit memory-only fixture. This
command does not read `.env`, connect to ERPBridge or Firestore, call a model
provider, or send email:

```powershell
npm ci
npm run demo:local
```

Sign in with `qa@example.test` / `Local-QA-only-2026!`. The fixture binds only
to `127.0.0.1:8081`; its records disappear when the process stops. Start the
frontend separately with `npm run demo:local` from `frontend` and open
`http://127.0.0.1:5173/`.

The configured development runtime below reads `backend-ts/.env` and can use
external services. Run it only after reviewing and authorizing every configured
ERPBridge, provider and storage endpoint:

```powershell
npm install
npm run dev
```

The default memory storage is intentionally non-durable. The owner-selected database is Cloud Firestore; the new opt-in `STORAGE_DRIVER=firestore-records` adapter has locally verified normalized encrypted persistence, exclusive-writer heartbeat and normal chat/read/collection integration. It requires explicit `FIRESTORE_PROJECT_ID`, `FIRESTORE_DATABASE_ID` (including `(default)` when intended), `FIRESTORE_WORKSPACE_ID` and a valid 32-byte server-held `STORAGE_ENCRYPTION_KEY` encoded as base64, hex, or a literal value. Leave legacy `FIRESTORE_ENCRYPTION_KEY` unset or exactly match that key. Server credentials never belong in frontend configuration. See the [configuration, emulator evidence and remaining migration/release gates](../docs/FIRESTORE_APPLICATION_RUNTIME_INTEGRATION_2026-10-06.md) before selecting it against any retained data.

Legacy aggregate data is never imported automatically. The bounded cutover tool
supports `export`, `verify`, `status` and `migrate`, requires a separate backup key and
refuses a changed source or nonempty normalized target. It retains the legacy
document. Read the complete [cutover contract and operator sequence](../docs/FIRESTORE_RECOVERABLE_CUTOVER_2026-10-08.md) and [staged activation contract](../docs/FIRESTORE_STAGED_CUTOVER_ACTIVATION_2026-10-08.md) before using `npm run cutover:firestore -- <mode>`. Staged cutover is bounded to 5,000 records plus image/chunk/manifest budgets and is not a substitute for cloud restore/rollback, IAM/index/quota qualification or beyond-bound migration design.

Existing `postgres` / `postgres-records` drivers and data remain available for regression/explicit migration, using `DATABASE_URL` and `STORAGE_ENCRYPTION_KEY`. Legacy `STORAGE_DRIVER=firestore` is still the unqualified aggregate/mirror adapter; it must not be substituted for verified execution storage. No driver selection implicitly imports or resets data, creates a cloud project or completes production qualification. Runtime registry files are created under `configs/runtime/` from the frozen copies stored in this folder's parity fixtures.

Supported published read workflows can use `mode: "async-read"` with a 16–128 character idempotency key. `BACKEND_WORKER_CONCURRENCY` defaults to 2 (1–8) and controls the bounded in-process pool used by read, operation, and readback jobs; the legacy `READ_WORKER_CONCURRENCY` name remains compatible. `READ_WORKER_PER_ACTOR` defaults to 1 (1–worker count), and `READ_WORKER_LEASE_MS` to 30000 (5000–300000). Independent principals share bounded fair slots; actions inside a workflow remain ordered. Authenticated private leases are renewed and checked at SDK entry. Interrupted/expired/uncertain jobs require recovery, not automatic replay. Do not wrap the standalone host or Firebase Functions in `node:cluster`: the qualified storage adapters intentionally use exclusive writer ownership. Firebase scales through its own instances and task queues. See [worker behavior and verification](../docs/FAIR_READ_WORKERS_AND_SDK_LEASE_FENCES_2026-10-06.md).

For the OpenRouter demo path, configure the OpenAI-compatible provider with a pinned model ID:

```powershell
$env:GENERATION_BASE_URL = "https://openrouter.ai/api/v1"
$env:GENERATION_API_KEY = "[REDACTED]"
$env:GENERATION_MODEL_PRIMARY = "openai/gpt-4o-mini-2024-07-18"
$env:GENERATION_MODEL_FALLBACK = ""
$env:GENERATION_TIMEOUT_MS = "30000"
$env:GENERATION_TEMPERATURE = "0"
$env:GOVERNANCE_URL = "https://policy-source.example/evaluate"
$env:GOVERNANCE_API_KEY = "[REDACTED]"
$env:GOVERNANCE_TIMEOUT_MS = "10000"
$env:GOVERNANCE_SECONDARY_URL = ""
$env:GOVERNANCE_CACHE_TTL_MS = "60000"
npm run dev
```

The model string is passed through unchanged. Do not use a floating alias such as `:latest`. Mock MCP mode supports `demo.echo` and the realistic read-only `fetch_attendance` demo action; configuration rejects mock mode when `APP_ENV=production`.

## ERPBridge MCP transport

The default `MCP_TRANSPORT=bridge-v1` preserves the existing bridge client. To use authenticated ERPBridge MCP, set `MCP_TRANSPORT=erpbridge-mcp` and provide a scoped `mcp` token. The engine calls ERPBridge `/mcp/` through its private SDK adapter; it does not use the admin-only `/api/tools/invoke` endpoint.

```powershell
$env:MCP_TRANSPORT = "erpbridge-mcp"
$env:ERPBRIDGE_BASE_URL = "https://erpbridge.example"
$env:ERPBRIDGE_MCP_TOKEN = "[REDACTED]"
$env:ERPBRIDGE_ROLE_MAP = '{"Workflow Builder":"workflow_builder","Client":"client"}'
npm run dev
```

Instead of putting the token in the process configuration value, select a secret-manager environment variable by name:

```powershell
$env:ERPBRIDGE_MCP_TOKEN_ENV = "WORKFLOW_ERPBRIDGE_TOKEN"
```

`ERPBRIDGE_MCP_TOKEN` and `ERPBRIDGE_MCP_TOKEN_ENV` are mutually exclusive. The role map is strict JSON, accepts the built-in local role names only, and rejects duplicate ERPBridge target roles. Non-development endpoints must use HTTPS. Do not include the token in logs, diagnostics, or public configuration responses.

For two to eight backend-owned ERPBridge deployments, replace all four legacy
`ERPBRIDGE_*` connection values above with one catalog and an explicit primary
ID. The catalog contains environment-variable names, never token values:

```powershell
$env:MCP_TRANSPORT = "erpbridge-mcp"
$env:ERPBRIDGE_PRIMARY_CONNECTION_ID = "finance"
$env:ERPBRIDGE_CONNECTIONS_JSON = '[{"id":"finance","baseURL":"https://finance-bridge.example","tokenEnv":"FINANCE_ERPBRIDGE_TOKEN","roleMap":{"Platform Admin":"finance_admin","Workflow Builder":"finance_builder"}},{"id":"hr","baseURL":"https://hr-bridge.example","tokenEnv":"HR_ERPBRIDGE_TOKEN","roleMap":{"Platform Admin":"hr_admin"}}]'
$env:FINANCE_ERPBRIDGE_TOKEN = "[REDACTED]"
$env:HR_ERPBRIDGE_TOKEN = "[REDACTED]"
npm run dev
```

Each named connection has independent desired state, revision, operation
history, initialization session and rotation behavior. Settings may initialize,
test and disconnect any configured connection. Workflow/chat execution still
uses only the explicit primary connection; secondary readiness does not grant
dispatch authority. Per-node connection binding is a separate unfinished gate.
Catalog IDs are lowercase bounded identifiers, URLs must be host roots, and one
to eight entries with exactly one primary are accepted. Mixing the catalog with
legacy single-connection values is rejected.

See [ERPBridge integration](docs/ERPBRIDGE_INTEGRATION.md) for the role matrix, token rotation, deployment checks, and audit boundary.

## ERP data-transformation uploads

The frontend never receives the data-transformation service key. Configure the
trusted application backend with the pipeline's service origin and matching
`ERP_API_KEY`; authenticated requests under `/api/pipeline/v1/*` require the
`pipeline:upload` role permission and are audited before bytes leave this
application.

```powershell
$env:PIPELINE_API_BASE_URL = "http://127.0.0.1:8000"
$env:PIPELINE_API_KEY = "[REDACTED]"
$env:PIPELINE_TIMEOUT_MS = "180000"
npm run dev
```

Outside development, `PIPELINE_API_BASE_URL` must be a credential-free HTTPS
service origin. Uploads accept one bounded multipart file. Document identity
metadata is forwarded, while audit records keep only hashes and non-secret
classification fields. Chat retrieval is a different route: reviewed read-only
tools call the pipeline through ERPBridge, not through these upload endpoints.
See [the full pipeline integration runbook](../docs/DATA_TRANSFORMATION_PIPELINE_INTEGRATION_2026-10-14.md).

## Verify

```powershell
npm run verify
firebase emulators:exec --only firestore --project demo-lcwe-records --config firestore.emulator.json "npm run verify:firestore-cutover"
```

The first command type-checks, runs the test suite, and builds the production
artifact. The second is a separate guarded, synthetic, loopback-only Firestore
cutover rehearsal; ports 23671–23674 must be free.

The runtime security claims are deliberately narrower than the Go compile-time claims; see [docs/INVARIANTS.md](docs/INVARIANTS.md) and [docs/MIGRATION.md](docs/MIGRATION.md).

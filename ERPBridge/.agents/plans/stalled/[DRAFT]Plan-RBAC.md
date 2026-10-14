# Plan: Per-Tool Role-Based Access Control (RBAC)

> **Status: STALLED / SUPERSEDED** — Do not execute this plan independently. Its AuthZ work was merged with token authentication in `../completed/[COMPLETED]AuthN-AuthZ-Plan.md`.

## Goal

Tool authors declare a role allow-list in the tool schema (`spec.security.allowedRoles`). The authenticated caller identity provides a role per invocation; calls with a role outside the list are denied before any ERP call or cache read. Tools without an allow-list stay open and preserve their existing arguments (back-compat).

## User-Confirmed Decisions

| Question | Answer |
|---|---|
| Role transport | **Both** — guarded MCP tools use a reserved tool argument; guarded direct invokes use a header |
| Tool with NO allow-list | **Allow everyone** (opt-in RBAC, backwards compatible) |
| Schema field location | **`spec.security.allowedRoles`** |
| Enforcement surfaces | **Both** MCP `tools/call` and `/api/tools/invoke` |

## Current State (verified 2026-08-22)

- Tool spec has `Security{AuthType, CredentialRef}` only — no access control field (internal/mcp/tool.go:84-88).
- MCP call path: `handleMCPToolCall` (internal/mcp/server.go:499) resolves tool → executes args; it currently has no authenticated caller identity.
- Direct invoke: `/api/tools/invoke` (internal/mcp/server.go:751) resolves tool → builds chain → executes; it currently has no role header extraction or authorization status mapping.
- Chain order (both surfaces): rate-limit/logging/metrics → `CacheMiddleware` → base handler. **Cache lookup precedes any handler code**, so the role check must wrap cache, not sit inside the base handler.
- Cache already supports role-scoped keys via `roleScope(role, isReadOnly)` (internal/cache/manager.go:139) but `CacheMiddleware` hardcodes `role := ""` → `"anonymous"` (internal/mcp/middleware.go:176).
- Admission controller `validateTool` (internal/mcp/server.go:724) validates name/version/secrets — extendable for role rules.
- No bridgectl `invoke` command exists; `/api/tools/invoke` is consumed by tests/Postman only — no CLI change required.
- `Plan-Auth.md` will authenticate HTTP bearer tokens and attach a token principal to the request context, but it does not yet define role membership. RBAC must extend that context with verified roles; it must not trust a client-declared role as an authorization claim.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| R-D1 | Field: `spec.security.allowedRoles []string` (omitempty) | Additive and colocated with existing tool security configuration |
| R-D2 | Empty list ⇒ open to all and no RBAC role processing | Preserves existing tools, including a business argument named `role`, and prevents arbitrary cache partitioning |
| R-D3 | Non-empty list ⇒ fail closed: missing verified role or non-member ⇒ denied | An allow-list must be based on authenticated identity, not a user assertion |
| R-D4 | Identity source is `Plan-Auth`'s authenticated token principal, extended to carry the principal's permitted roles. MCP `arguments.role` and direct `X-ERPBridge-Role` select one of those roles for a guarded tool; they never grant a role. The existing admin-only direct-invoke route uses explicit `API_AUTH_ADMIN_ROLES`; MCP bearer tokens use roles persisted with the token. | Keeps the existing direct-invoke surface boundary while making the allow-list effective access control |
| R-D5 | Direct invoke accepts `X-ERPBridge-Role` only for guarded tools. It rejects a simultaneous `arguments.role` with HTTP 400. MCP accepts `arguments.role` only for guarded tools. | One unambiguous role selector per transport; open tools retain normal arguments |
| R-D6 | Normalize selectors exactly once: require a string, trim no whitespace (reject non-canonical values), and require `[a-z][a-z0-9_-]{0,63}`. The selected role must be in both the authenticated principal's roles and the tool allow-list. | Prevents selector ambiguity and user-controlled cache-key cardinality |
| R-D7 | `RoleAuthzMiddleware(t)` executes between global middlewares and `CacheMiddleware`; it validates the selected role, removes it only from guarded-tool arguments, and stores it in context. | Authorization runs before cache, so denied callers cannot read stale entries after an allow-list change |
| R-D8 | A shared typed `RoleAuthorizationError` drives denial mapping: MCP returns an `isError` tool result; direct invoke maps it to HTTP 403. The direct preflight uses the same extraction/authorization helper and passes the resulting context to the middleware guard. | Avoids divergent duplicate policies and the current blanket 500 mapping for MCP error results |
| R-D9 | Discovery: guarded tools' served `tools/list` schema gets a deep-copied `properties.role = {type: string, enum: principal-independent allowedRoles}`; stored spec remains untouched and `role` is not required. | Lets MCP clients discover valid selectors without changing persisted tool input schemas |
| R-D10 | Admission rules: role entries must match `[a-z][a-z0-9_-]{0,63}`, be unique, non-empty, and number at most 32; reject an author-defined input `role` property only when `allowedRoles` is non-empty. | Reserves `role` only where RBAC is active, preserving open-tool compatibility |
| R-D11 | `CacheMiddleware` reads `CallerRoleFromContext(ctx)` only for guarded tools; open tools continue with the empty role. Guarded non-read-only tools are role-isolated, while `isReadOnly: true` remains shared. | Uses the existing cache isolation model without altering open-tool cache behavior |
| R-D12 | Role membership is mandatory Plan-Auth work, not a later caveat. Until tokens can carry verified roles, this plan is blocked and must not ship as RBAC. | Documents the actual security boundary honestly |

## Scope

**In:** Plan-Auth role-membership extension and shared identity context; schema field + admission validation; authz core + middleware; wiring into both invocation chains; tools/list schema injection; guarded-tool cache role-scoping; docs + CHANGELOG + Postman + public-docs commit.

**Out:** unauthenticated client-declared roles; per-role rate limits; role-management UI/API beyond assigning roles when a token is created; unauthenticated stdio RBAC; resources/prompts RBAC.

## Tasks

- [ ] **R0 — Establish authenticated role identity (Plan-Auth prerequisite)** — amend Plan-Auth to extend the authenticated token model with an immutable validated role set and add `WithCallerIdentity` / `CallerIdentityFromContext` helpers. Token creation validates and persists the roles; authentication places the principal ID and roles in request context. Add `API_AUTH_ADMIN_ROLES` for the existing environment admin because `/api/tools/invoke` remains admin-only under Plan-Auth; without configured admin roles, direct invocation of guarded tools is denied. MCP bearer tokens use their persisted roles. Define unauthenticated stdio behavior as: open tools work; guarded tools deny.
      Tests: token role persistence, invalid/duplicate role rejection, revoked/expired token cannot yield an identity, admin without configured roles is denied, direct invoke retains its admin-only gate, and the identity context survives the MCP HTTP wrapper.
      (**Files:** Plan-Auth-owned token/auth files, internal/mcp/authz.go, relevant tests, docs/environment-variables.md;
      **Verify:** `go test ./internal/mcp/ -run 'Test(Auth|Token|CallerIdentity)'`)
- [ ] **R1 — Authz core (TDD)** — add `internal/mcp/authz.go` and `authz_test.go`.
      Constants: `RoleArgKey = "role"`, `RoleHeader = "X-ERPBridge-Role"`. Add a typed `RoleAuthorizationError` with non-enumerating public messages. `AuthorizeToolRole(t, identity, selectedRole)` returns nil for open tools and otherwise requires a valid canonical selector that belongs to both identity roles and `AllowedRoles`. Context helpers: `WithCallerRole(ctx, role)` and `CallerRoleFromContext(ctx)`.
      `RoleAuthzMiddleware(t)` is a no-op for open tools. For guarded tools it reads the preselected context role (direct invoke) or validates `arguments.role` (MCP), authorizes it, copies then removes the selector from arguments, stores the role in context, and calls next. It must not mutate the request argument map shared with outer middleware/logging.
      (**Files:** internal/mcp/authz.go, authz_test.go;
      **Verify:** `go test ./internal/mcp/ -run TestAuthz`)
- [ ] **R2 — Wire both surfaces and status mapping** — wrap `CacheMiddleware` with `RoleAuthzMiddleware(t)` in `RegisterTool` and `handleDirectInvoke`, so the execution order is global middleware → role authorization → cache → handler. Direct invoke uses one shared helper to extract and validate `X-ERPBridge-Role`, rejects an `arguments.role` collision with 400, creates `WithCallerRole(r.Context(), role)`, and maps `RoleAuthorizationError` to 403. Keep the middleware as the cache-order guard; do not create a second policy implementation.
      Tests: MCP allowed/missing/wrong role returns the expected MCP result; direct invoke returns 200/403/400 as appropriate; denied requests never call the connector or cache backend; guarded ERP payload has no role selector; an open tool's business `role` argument reaches ERP unchanged.
      (**Files:** internal/mcp/server.go, server_test.go, api_test.go;
      **Verify:** `go test ./internal/mcp/ -run 'TestServer_DirectInvoke|TestRBAC'`)
- [ ] **R3 — Discovery and admission** — add `AllowedRoles` to `Security`. Deep-copy the guarded tool schema before `RegisterTool` serializes it, inject `properties.role = {type: string, enum: allowedRoles}`, and keep it out of `required`. Extend `validateTool`: validate canonical role syntax, reject empty entries and duplicates, cap at 32, and reject an input-schema `role` collision only for guarded tools. Test through an actual MCP `tools/list` JSON-RPC response plus tool API persistence/reload; confirm stored schema and open-tool schemas are unchanged.
      (**Files:** internal/mcp/tool.go, internal/mcp/server.go, server_test.go, api_test.go;
      **Verify:** `go test ./internal/mcp/ -run 'TestValidateTool|TestSchemaInjection|TestToolsList'`)
- [ ] **R4 — Cache role scoping** — use `CallerRoleFromContext(ctx)` only when `AllowedRoles` is non-empty; otherwise retain the empty cache role. Test two allowed roles produce distinct entries for guarded non-read-only tools, `isReadOnly: true` stays shared, open-tool requests containing business `role` values share their existing cache entry, and a role denied after a live allow-list update cannot receive a cached response.
      (**Files:** internal/mcp/middleware.go, middleware_test.go;
      **Verify:** `go test ./internal/cache/ ./internal/mcp/ -run 'TestCache|TestRBAC'`)
- [ ] **R5 — Docs sync** — document authenticated token role assignment and selector semantics in the Plan-Auth/token guide; update `docs/tool-schema.md` with an annotated guarded-tool example; update `docs/api.md` with `X-ERPBridge-Role`, 400 collision, and 403 semantics; update `docs/connectivity.md`, `CHANGELOG.md`, and `erpbridge_postman_collection.json`; make a matching commit in `erpbridge-docs`. Clearly state that stdio cannot invoke guarded tools until it has an authenticated identity transport.
      (**Verify:** `rg -n "allowedRoles|X-ERPBridge-Role|authenticated.*role|guarded" docs/ CHANGELOG.md` covers every surface)

## Verification

1. Full matrix green: open tool × (no role / business `role` argument) ⇒ pass unchanged; guarded tool × (missing selector / malformed selector / selector absent from token roles / selector absent from allow-list / valid selector) ⇒ deny / deny / deny / deny / pass. The policy is identical on MCP and `/api/tools/invoke`.
2. Guarded MCP invocation with an unauthenticated identity (including stdio) is denied. A client cannot obtain access merely by asserting an allowed role.
3. Denied calls never touch ERP connector or cache backend, and a cached response cannot bypass a changed allow-list.
4. The selector never reaches guarded-tool ERP payloads or guarded cache keys. An open tool's business `role` argument still reaches ERP and preserves its current cache behavior.
5. The final wire-level `tools/list` response exposes the selector property and enum for guarded tools only; persisted tool data remains unchanged.
6. Scoped lint clean: `golangci-lint run ./internal/mcp/...`; full `make test` green before each atomic task commit.
7. Manual smoke: create a token with `finance-reader`; apply a guarded tool allowing that role; invoke without selector or with another token role ⇒ denied; invoke with `finance-reader` ⇒ success; apply an open tool accepting ERP field `role` ⇒ its payload remains unchanged.

## Open Questions

None. `R0` is a hard prerequisite: do not execute the RBAC tasks until Plan-Auth supplies verified role membership in request context. Candidate follow-up: role-management UI/API.

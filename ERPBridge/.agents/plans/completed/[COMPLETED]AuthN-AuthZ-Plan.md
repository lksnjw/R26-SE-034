# Plan: Authentication and Authorization (AuthN/AuthZ)

> **Status: COMPLETED** — implemented and verified on 2026-08-22. This is the historical execution record for API-token authentication and per-tool RBAC. It supersedes `../stalled/Plan-Auth.md` and `../stalled/[DRAFT]Plan-RBAC.md`.

## Goal

Provide token-based authentication for ERPBridge HTTP surfaces and enforce per-tool role allow-lists using roles verified from the authenticated caller identity. Preserve open tools and their existing arguments, fail closed for guarded tools without a verified identity, and prevent denied callers from reaching cache or downstream ERP calls.

## Current State

- Tools have `Security.AuthType` and `Security.CredentialRef`, but no role allow-list (`internal/mcp/tool.go:84-88`). Registration composes global middleware → cache → handler (`internal/mcp/server.go:454-496`), so authorization must wrap cache.
- The cache supports role-scoped keys but `CacheMiddleware` supplies an empty role (`internal/cache/manager.go:136-146`, `internal/mcp/middleware.go:149-176`).
- HTTP routes are registered without authentication and direct invocation maps every MCP error result to HTTP 500 (`internal/mcp/server.go:553-572`, `751-824`).
- The rate limiter already has a context principal seam (`internal/mcp/middleware.go:65-79`). SQLite persistence belongs in `Store.init` (`internal/mcp/store.go:36-85`).
- Bridgectl lacks a shared authenticated request builder (`internal/cli/tool.go:121-125`, `internal/cli/cache.go:36-41`, `internal/cli/log.go:43-48`).

## Decisions

| # | Decision | Rationale |
|---|---|---|
| AA-D1 | API tokens are opaque random bearer credentials. Store only SHA-256 hashes, metadata, scopes, expiry/revocation state, and a sorted JSON role list. Return a generated value once. | Database leaks must not reveal usable tokens; deterministic roles simplify validation. |
| AA-D2 | `API_AUTH_TOKEN` remains the environment-admin credential. `API_AUTH_ADMIN_ROLES` is a validated comma-separated role list. Token roles are assigned at creation with repeatable `--role` and are immutable. | Direct invoke stays admin-only while both admin and MCP tokens can have verified roles. |
| AA-D3 | Authentication attaches immutable `CallerIdentity { PrincipalID, Roles, IsAdmin }` to context. Tool arguments and headers select a role but never grant one. | Client-declared roles alone are not access control. |
| AA-D4 | Auth is enabled only when `API_AUTH_TOKEN` is set. MCP requires `mcp`; metrics requires `metrics`; logs require `logs`; registry, cache, tokens, and direct invoke remain admin-only. Health stays open. | Retains the existing AuthN surface boundary and opt-in rollout. |
| AA-D5 | In auth-open mode, HTTP routes remain compatible and log a warning, but guarded tools deny because no caller can prove a role. Stdio remains available for open tools only. | Authorization remains fail-closed. |
| AA-D6 | `spec.security.allowedRoles` is opt-in. Guarded MCP calls select `arguments.role`; guarded direct invokes select `X-ERPBridge-Role` and reject an argument selector with 400. Open tools do not reserve business `role`. | Preserves existing ERP payload contracts. |
| AA-D7 | Roles and selectors match `[a-z][a-z0-9_-]{0,63}`; reject empty, duplicate, or >32-role lists. A selector must be in both identity and tool allow-list. | Canonical values prevent ambiguity and cache-key abuse. |
| AA-D8 | `RoleAuthzMiddleware` runs after global middleware and before cache. A typed error maps to MCP `isError` or direct HTTP 403, and removes selectors only from guarded arguments. | Denied callers cannot read cache; one error contract avoids direct-route 500s. |
| AA-D9 | Guarded non-read-only cache entries isolate by verified role. Guarded read-only entries remain shared. Open-tool cache behavior is unchanged. | Safe caching without breaking unguarded tools. |
| AA-D10 | CORS stays MCP-only. Auth mode uses explicit `CORS_ALLOWED_ORIGINS`; allowed preflight is processed before bearer auth. | Supports browser MCP without exposing management APIs. |

## Scope

**In:** token lifecycle, identity, scopes, admin roles, MCP CORS, bridgectl authentication, schema RBAC, enforcement, cache isolation, tests, docs, Postman, changelog, and matching public docs.

**Out:** OAuth AS/PKCE/dynamic registration, token role editing, per-role rate limits, unauthenticated stdio RBAC, resources/prompts RBAC, and an admin RBAC bypass.

## Tasks

- [x] **AA1 — Token and identity foundation (TDD).** Create `api_tokens` migration/store for hashed opaque tokens, scopes, expiry/revocation, and sorted JSON roles. Add role validation and immutable `CallerIdentity` context helpers. Generate `erpbt_` plus 32 cryptographically random bytes; never expose stored hashes or token values.
  **Seam:** `Store.init` and SHA-256 token lookup; **Files:** `internal/mcp/store.go`, `internal/mcp/tokens.go` (new), `internal/mcp/{store,tokens}_test.go`; **Verify:** `go test ./internal/mcp/ -run 'Test(Store|Token|CallerIdentity)'`.

- [x] **AA2 — HTTP authentication and route policy (TDD).** Add shared bearer validation: constant-time admin compare, hash lookup, expiry/revocation/scope checks, identity attachment, and rate-limit principal attachment. Read `API_AUTH_TOKEN` and `API_AUTH_ADMIN_ROLES`; warn in open mode. Register admin-only token create/list/revoke and gate routes per AA-D4.
  **Seam:** server mux wrappers; **Files:** `internal/mcp/{server,tokens,auth}.go`, `services/erpbridge-server/main.go`, `internal/mcp/{api,server,tokens}_test.go`; **Verify:** `go test ./internal/mcp/ -run 'Test(Auth|Token|Server)'`.

- [x] **AA3 — Streamable MCP identity propagation and CORS (TDD).** Wrap `/mcp/` so authenticated request identity reaches MCP tool handlers. Keep inactive-tool filtering inside the authenticated handler. Apply MCP-only CORS and unauthenticated allowed-preflight ordering.
  **Seam:** `ServeHTTP` streamable wrapper; **Files:** `internal/mcp/server.go`, `internal/mcp/server_test.go`, `docs/connectivity.md`; **Verify:** `go test ./internal/mcp/ -run 'TestServer_(MCP|CORS|ServeHTTP)'`.

- [x] **AA4 — Principal-aware limiting and log hygiene.** Use `CallerIdentity.PrincipalID` for HTTP limiter keys and retain current session/process fallback for open mode and stdio. Ensure bearer credentials and authorization headers use shared redaction.
  **Seam:** `RateLimitMiddleware.Handle`; **Files:** `internal/mcp/middleware.go`, `internal/logger/{logger,redact}.go`, related tests; **Verify:** `go test ./internal/mcp/... ./internal/logger/...`.

- [x] **AA5 — Bridgectl authentication and token lifecycle.** Add `api-token`, `BRIDGE_API_TOKEN`, and persistent `--token` with flag → environment → context precedence. Route all bridge-server calls through one request builder. Add `token create --name <name> [--scope ...] [--role ...] [--expires ...]`, list, and revoke; preserve upstream ERP auth behavior.
  **Seam:** configured context and bridge HTTP calls; **Files:** `internal/config/config.go`, `internal/cli/{root,context,tool,cache,log,token}.go`, CLI tests; **Verify:** `go test ./internal/cli/...` and `rg -n 'http.Get|DefaultClient' internal/cli/` finds no bridge request outside the helper.

- [x] **AA6 — RBAC schema, validation, and discovery (TDD).** Add `Security.AllowedRoles`; validate AA-D7; reject an author-defined input `role` only for guarded tools. Deep-copy guarded schemas at MCP registration and inject optional `properties.role` enum without changing stored/open schemas.
  **Seam:** `validateTool` and `RegisterTool`; **Files:** `internal/mcp/{tool,server}.go`, `internal/mcp/{api,server,tool}_test.go`; **Verify:** `go test ./internal/mcp/ -run 'Test(ValidateTool|SchemaInjection|ToolsList)'`.

- [x] **AA7 — RBAC core and transport enforcement (TDD).** Add selector extraction, typed `RoleAuthorizationError`, `WithCallerRole`, and `RoleAuthzMiddleware`. For guarded tools, verify selector syntax and membership in identity plus allow-list, then copy and remove it from arguments. Direct invoke preflights only the header selector, rejects collisions with 400, and maps denial to 403; MCP returns `isError`.
  **Seam:** middleware composition in `RegisterTool` and `handleDirectInvoke`; **Files:** `internal/mcp/{authz,server}.go`, `internal/mcp/{authz,api,server}_test.go`; **Verify:** `go test ./internal/mcp/ -run 'Test(Authz|RBAC|Server_DirectInvoke)'`.

- [x] **AA8 — Authorization-safe cache scoping (TDD).** Place RBAC outside cache and pass context role only for guarded tools. Retain open-tool cache keys and read-only sharing.
  **Seam:** `CacheMiddleware`; **Files:** `internal/mcp/middleware.go`, `internal/mcp/middleware_test.go`; **Verify:** `go test ./internal/mcp/ -run 'Test(Cache|RBAC)'`.

- [x] **AA9 — Documentation and release verification.** Update token, API, connectivity, environment, and schema docs; Postman; `CHANGELOG.md`; and matching public Docusaurus docs. Document role sources, direct admin-only behavior, selector rules, open-tool `role` compatibility, guarded stdio denial, and CORS.
  **Seam:** public API documentation; **Files:** `docs/{api,connectivity,environment-variables,tool-schema,tokens}.md`, `erpbridge_postman_collection.json`, `CHANGELOG.md`, public docs; **Verify:** `rg -n 'API_AUTH_TOKEN|API_AUTH_ADMIN_ROLES|CORS_ALLOWED_ORIGINS|allowedRoles|X-ERPBridge-Role' docs/ CHANGELOG.md`, Postman JSON parse, public-doc `npm run build`, and `make test`.

## Verification

1. AuthN matrix covers open/protected mode, missing/invalid/revoked/expired bearer, scopes, admin, and MCP CORS preflight.
2. Token and admin roles are validated, never logged, and reach MCP handler contexts.
3. Open tools, including business `role` arguments, remain unchanged. Guarded tools deny missing identity, malformed selector, identity mismatch, and allow-list mismatch; valid selectors succeed over MCP and direct invoke.
4. Denied guarded calls never call ERP or cache. Cached data cannot bypass an updated allow-list; isolation and read-only sharing behave as specified.
5. Each task has focused tests, package-scoped lint, an atomic Conventional Commit, and required in-repo/public documentation. `make test` is green before handoff.

## Open Questions

None. Confirmed defaults: token roles plus `API_AUTH_ADMIN_ROLES`; guarded tools deny without authenticated identity.

# Plan: API Token Authentication (token-based, minimal)

> **Status: STALLED / SUPERSEDED** — Do not execute this plan. Its AuthN work was merged with RBAC sequencing in `../completed/[COMPLETED]AuthN-AuthZ-Plan.md`.

## Goal

Give ERPBridge token-based authentication on its HTTP surface:

- **kubectl-style for bridgectl**: a per-context `api-token` in `~/.bridgectl/config.yaml`, sent as `Authorization: Bearer` on every request.
- **Third-party frontends**: connect over MCP (`/mcp/`) with a bearer token carrying an `mcp` scope.
- **External observability**: token-gated `/metrics` (Prometheus `bearer_token`) and `/api/logs/*`.
- One env var (`API_AUTH_TOKEN`) turns enforcement on; nothing breaks until it is set.

Scope decision (user-confirmed): this is a single service deployed inside the server — a plain token-based model, no OAuth authorization server, no PKCE, no dynamic client registration.

## Current State

- bridgectl sends **zero credentials**: 9 bare `http.DefaultClient` call sites (verified 2026-08-20) —
  `internal/cli/tool.go:75` (POST apply), `:121` (GET, shell completion), `:147`, `:228` (describe), `:400` (DELETE),
  `internal/cli/cache.go:41`, `:98`, `internal/cli/log.go:48` (SSE tail), `:109`.
  The only header ever set is `Content-Type` (tool.go:73). Context `Auth` config exists but is consumed only by
  `bridgectl api test` for ERP connectivity (internal/cli/api.go:150) — never attached to server calls.
- Server validates **nothing**: mux registers handlers bare (internal/mcp/server.go:559-568); CORS allows the
  `Authorization` header but no code ever reads it (server.go:472); MCP streamable HTTP is stateful with no auth
  (server.go:465-475). Grep across server code shows no `Authorization` reads outside `internal/connector` (ERP layer).
- No other consumers in-repo: compose healthchecks hit mock-erp `/health` and `redis-cli ping`
  (docker-compose.yml:9-16, 28-29); no Prometheus config; CI (`release.yml`) is build/release only.
- mcp-go v0.57.0 (vendored) has **no OAuth authorization server** — only RFC 9728 protected-resource metadata
  (`server.WithProtectedResourceMetadata`, vendor/.../server/streamable_http.go:208). Client-side OAuth exists only in
  newer mcp-go client transports (PR #296). Stdio has no auth channel (spec; `ServeStdio` wires os.Stdin/os.Stdout,
  vendor/.../server/stdio.go:840-866).

## Decisions

| # | Decision | Rationale / rejected |
|---|---|---|
| A-D1 | **Admin credential**: `API_AUTH_TOKEN` env, checked with `crypto/subtle.ConstantTimeCompare` on every request. Rotation = change env + restart (documented, one line). | No seed-once, no rotate command, no last-admin guard: env admin always exists ⇒ operator can never lock themselves out. |
| A-D2 | **Store tokens**: `api_tokens` SQLite table — `id, name, sha256(token), scopes, created_at, expires_at (nullable), revoked_at (nullable)`. Value = 32 bytes `crypto/rand` → `erpbt_` + 64 hex, **returned once** at creation. Lookup by `sha256(bearer)` per request. Expired creation is rejected and time is injectable in tests. | Hash-only storage (DB leak-safe); kubectl `create token` value-once behavior. |
| A-D3 | **Scopes**: comma-separated list of `mcp\|metrics\|logs` (default all three), single `--scope` flag at creation. No role table, no free-form permissions. | Minimal; matches the three external surfaces. |
| A-D4 | **Enforcement**: `API_AUTH_TOKEN` set ⇒ all gated routes require a valid Bearer token (env admin or store token with matching scope), else `401` + `WWW-Authenticate: Bearer`. Unset ⇒ routes open + startup warning. No modes, no `API_AUTH_REQUIRED`. | Back-compat; secure by construction once enabled. |
| A-D5 | **MCP auth**: bearer token via `Authorization` header. No OAuth AS, no `/.well-known/oauth-protected-resource` metadata (there is no AS to discover). Stdio stays open, documented as local-only (spec has no stdio auth). | mcp-go v0.57.0 ships no AS; OAuth is overkill for a single service behind a server. |
| A-D6 | **Surface map**: `mcp` → `/mcp/`; `metrics` → `/metrics` (main.go:121); `logs` → `/api/logs/recent`, `/api/logs/stream`. Admin-only: `/apis/erpbridge.io/v1/tools`, `/api/tools/invoke` (bridgectl/testing), `/api/cache/*`, token management. Always open: `/mcp/health`, stdio. | Frontends use MCP (user decision); `/api/tools/invoke` is bridgectl/testing only. |
| A-D7 | **Token management routes** (admin-only): `POST /apis/erpbridge.io/v1/tokens` (create, value-once), `GET .../tokens` (names/dates only), `DELETE .../tokens/{id}` (revoke, immediate). | K8s-style family consistent with existing tools API. |
| A-D8 | **CORS**: CORS applies only to `/mcp/`. With auth disabled, retain `*`. With `API_AUTH_TOKEN` set, enable cross-origin MCP only for explicit `CORS_ALLOWED_ORIGINS`; when unset, emit no MCP CORS headers and log a startup warning. `OPTIONS` is unauthenticated and allow-list checked before auth. Management, health, logs, cache, and metrics routes stay outside browser CORS. | Browser frontends use MCP; permissive CORS must not expose admin surfaces. |
| A-D9 | **bridgectl**: `Context` gains `api-token` (yaml `api-token`, env `BRIDGE_API_TOKEN`, persistent `--token` flag); one shared `newRequest(ctx, method, url, body, token)` helper injects `Authorization: Bearer`; all **nine** bridge-server call sites + new token commands route through it. | Mirrors kubeconfig `users[].user.token`; single seam. |
| A-D10 | **Immediate enforcement**: validation is a per-request DB read (revoked/expired/scope). No cache. | Revocation must be instant; SQLite read cost is negligible at this scale. |
| A-D11 | **Log hygiene**: token values never logged; masq field-name list already masks `token` keys (mcp_handler.go) — audit during S2 (Plan-main) to cover `Authorization` header values in debug body logs. | Hard requirement for the feature. |
| A-D12 | **Authenticated limiter identity**: authorization places `admin` or token ID in request context; HTTP rate limits use that principal, while Stdio retains process/session limits. | Opening extra MCP sessions must not bypass a token’s rate limit. |

## Scope

**In:** `api_tokens` store + validation middleware; principal-aware limiting; token CRUD routes; MCP/metrics/logs gating; bridgectl `token create/list/revoke` + `api-token` plumbing; MCP-only CORS origins; docs + Postman + CHANGELOG; matching public-docs commit.

**Out:** OAuth AS / PKCE / dynamic client registration; per-tool/module scoping; stdio auth; token refresh/rotation UI; browser CORS for management/metrics APIs; multi-user identities.

## Tasks

- [ ] **A1 — Token store** — `api_tokens` table + CRUD.
      (**Seam:** `Store.init`, internal/mcp/store.go:40; **Files:** internal/mcp/store.go, store_test.go;
      **Verify:** `go test ./internal/mcp/ -run TestStore`)
      Schema: `api_tokens(id TEXT PK, name TEXT, token_hash TEXT UNIQUE, scopes TEXT, created_at INTEGER, expires_at INTEGER NULL, revoked_at INTEGER NULL)`. Use an injectable clock and reject expired tokens at creation.
      Methods: `CreateToken(t) (string, error)` (hash input, insert), `GetTokenByHash(hash) (*APIToken, error)`, `ListTokens() ([]APITokenView, error)` (no hash), `RevokeToken(id) error`.
- [ ] **A2 — Token handlers** — HTTP surface for token management.
      (**Seam:** mux registration, internal/mcp/server.go:559-568; **Files:** internal/mcp/tokens.go (new), server.go, api_test.go;
      **Verify:** `go test ./internal/mcp/` — POST returns value once; GET list shows no hash; DELETE 204; unknown id 404; non-admin 403)
      Value-once: generate `erpbt_`+64hex via crypto/rand, return in response, store only sha256.
- [ ] **A3 — Auth middleware** — enforcement + admin compare + scope gate.
      (**Seam:** mux construction, internal/mcp/server.go:462; **Files:** internal/mcp/server.go, main.go (read `API_AUTH_TOKEN`, startup warning), auth middleware tests;
      **Verify:** env unset ⇒ open + warning logged; env set ⇒ no header 401, env token 200, store token 200, wrong scope 403, revoked 401, expired 401)
      `authorize(r) (principal string, ok bool)`: constant-time compare against env token → `admin`; else hash lookup → revoked/expiry/scope check. Store the principal in context for the limiter.
- [ ] **A4 — MCP bearer gate** — `/mcp/` requires token when enforcement on.
      (**Seam:** `/mcp/` route, server.go:465-551; **Files:** internal/mcp/server.go, docs/connectivity.md;
      **Verify:** `curl -X POST http://localhost:8080/mcp/` without token ⇒ 401 when `API_AUTH_TOKEN` set; with `mcp`-scoped token ⇒ proceeds to MCP handshake)
      Note: the existing SSE tools/list filter must sit inside the gate so 401s are not filtered. Allowed CORS preflight is handled before the gate.
- [ ] **A5 — Metrics + logs gate** — `/metrics`, `/api/logs/recent`, `/api/logs/stream` behind middleware with `metrics`/`logs` scopes.
      (**Seam:** mux, server.go:560-565 + main.go:121; **Files:** internal/mcp/server.go, main.go, docs/environment-variables.md;
      **Verify:** 401 without token; 200 with matching scope; 403 with mismatched scope)
- [ ] **A6 — Scope enforcement matrix** — single `authorize(route, requiredScope)` helper + unit tests.
      (**Seam:** tokens.go validation path; **Files:** internal/mcp/tokens.go, tokens_test.go;
      **Verify:** full matrix: each of mcp/metrics/logs × each route; admin bypasses scope checks)
- [ ] **A7 — Principal-aware HTTP rate limiting** — use authorization context for HTTP limiter keys while retaining Stdio/session behavior.
      (**Seam:** `RateLimitMiddleware.getLimiter`; **Files:** internal/mcp/middleware.go, middleware_test.go;
      **Verify:** two HTTP sessions sharing one token share a limiter; distinct tokens do not; Stdio remains unchanged)
- [ ] **A8 — bridgectl token commands** — `token create --name <n> [--scope mcp,metrics,logs] [--expires 30d]`, `token list`, `token revoke <id>`.
      (**Seam:** `RootCmd` registration, internal/cli/root.go; **Files:** internal/cli/token.go (new), root.go, token_test.go (httptest server);
      **Verify:** `go test ./internal/cli/ -run TestToken`; create prints value once; revoke prompts like `tool delete` (confirm unless `--yes`))
      `--expires` accepts Go durations + `d` suffix (`30d` → 720h), and rejects already-expired input.
- [ ] **A9 — bridgectl api-token plumbing** — context field + shared request helper + all call sites.
      (**Seam:** `config.ActiveContext()` + all HTTP call sites; **Files:** internal/config/config.go (`api-token` yaml + `BRIDGE_API_TOKEN` override), internal/cli/context.go, root.go (`--token` persistent flag), internal/cli/{tool,cache,log}.go, cli tests;
      **Verify:** `rg -n "http.Get|DefaultClient" internal/cli/` returns nothing outside the helper; golden tests assert `Authorization: Bearer` present when token set, absent otherwise)
      Helper: `newRequest(ctx, method, url string, body io.Reader, token string) (*http.Request, error)` — sets `Content-Type: application/json` for bodies and `Authorization: Bearer <token>` when non-empty. Precedence: `--token` flag > `BRIDGE_API_TOKEN` env > context `api-token`.
- [ ] **A10 — MCP-only authenticated CORS** — `CORS_ALLOWED_ORIGINS` env and preflight ordering.
      (**Seam:** `NewStreamableHTTPServer` options and auth wrapper; **Files:** internal/mcp/server.go, main.go, CORS tests, docs/environment-variables.md;
      **Verify:** auth-off returns `*`; auth-on explicit origins allow only listed origins; auth-on unset origins warn and emit no CORS headers; allowed preflight succeeds without bearer; `/api/*`, `/apis/*`, `/mcp/health`, and `/metrics` do not gain CORS headers)
- [ ] **A11 — Docs + Postman + CHANGELOG**.
      (**Files:** docs/tokens.md (new — workflow: set env token → `token create` → frontend MCP bearer / Prometheus `bearer_token` → revoke), docs/api.md (token endpoints + auth header), docs/environment-variables.md (`API_AUTH_TOKEN`, `CORS_ALLOWED_ORIGINS`), docs/connectivity.md (MCP bearer), erpbridge_postman_collection.json (token create + authenticated invoke), CHANGELOG.md (Unreleased), matching `erpbridge-docs` pages;
      **Verify:** `rg -n "API_AUTH_TOKEN|CORS_ALLOWED_ORIGINS" docs/` covers every new var; Postman JSON parses; public-docs commit exists)

## Verification

1. Focused tests and package-scoped lint are green for each task; `make test` is green before handoff and commit.
2. **Bootstrap smoke**: `API_AUTH_TOKEN=op-...` server → `bridgectl token create --name frontend-a --scope mcp` → value printed once → `curl -H "Authorization: Bearer erpbt_..." /mcp/` proceeds; without token ⇒ 401.
3. **Revocation**: `bridgectl token revoke <id>` → same token ⇒ 401 immediately.
4. **Expiry**: `--expires` in the past is rejected at creation; a short-lived token becomes unauthorized after expiry.
5. **Scope enforcement**: `mcp` token on `/metrics` ⇒ 403; `metrics` token on `/api/logs/recent` ⇒ 403; admin env token passes everywhere.
6. **Open mode**: env unset ⇒ all routes open + startup warning; `/mcp/health` open in both modes.
7. **CORS:** allowed MCP preflight succeeds without bearer; disallowed/absent authenticated origins receive no CORS headers; management, health, and metrics routes remain without CORS.
8. **CLI hygiene**: every bridgectl request goes through `newRequest()`; no bare `http.Get`/`DefaultClient` remains.

## Open Questions

None — all decisions were refreshed in the 2026-08-22 grilling session. Follow `../README.md`: A1 → A7, then A8 → A9, then A10 → A11 after hardening security work.

## Review Addendum (2026-08-20) — code-vs-plan audit

All claims verified against the codebase. Findings below.

### Line-number drift

Files have grown since the plan was written. `server.go` is now 873 lines, `main.go` is 128 lines. All seam references are **approximately correct but shifted**. Locate by code pattern, not line number:

| Seam | Plan reference | How to find |
|---|---|---|
| Mux registration | `server.go:559-568` | Search for `mux.Handle` block |
| `/mcp/` route | `server.go:465-551` | Search for `"/mcp/"` |
| CORS setup | `server.go:469-473` | Search for `WithCORSAllowedOrigins` |
| Mux construction | `server.go:462` | Search for `http.NewServeMux` |
| Metrics route | `main.go:121` | Search for `"/metrics"` |

### Corrected facts

- Call-site count corrected from 11 to **9** (see Current State above). The original count likely included `api.go:150` (ERP connectivity) and a duplicate.

### Implementation notes

- **A3 startup warning**: Make the "open mode" warning prominent (`slog.Warn`, not debug) — it's a security posture indicator.
- **A9 is the highest-risk task** — it touches 9 call sites. The `newRequest()` helper should be implemented and tested before converting call sites.
- **A9 regression gate**: the verify command (`rg -n "http.Get|DefaultClient" internal/cli/`) is a candidate CI check.
- **Dependency with Plan-main**: A9's `newRequest()` helper lands before Plan-main D1–D3 (CLI improvements). Run S1–S3 from Plan-main before A1.

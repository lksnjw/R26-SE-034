# [COMPLETED] Plan: erpbridge-docs — Docusaurus site + GitHub Pages

Status: approved 2026-08-19. Decisions: Docusaurus (3.x, TypeScript), project page, public repo, manual content sync. **Completed 2026-08-19.**

## Task D1 — Create repo (done)

- `gh repo create nmdra/erpbridge-docs --public`, clone to `~/Documents/Projects/erpbridge-docs`.
- Verify: `git remote -v` shows origin `nmdra/erpbridge-docs`.

## Task D2 — Scaffold Docusaurus (done)

- `npx create-docusaurus@latest . classic --typescript` inside the clone.
- Verify: `npm run build` produces `build/`.

## Task D3 — Configure site

- `docusaurus.config.ts`: `url: https://nmdra.github.io`, `baseUrl: /erpbridge-docs/`, `organizationName: nmdra`, `projectName: erpbridge-docs`, navbar (Docs, GitHub), dark-mode default, footer.
- Add plugins: `@easyops-cn/docusaurus-search-local`, `@docusaurus/plugin-sitemap`.
- Add empty `.nojekyll` in `static/`.
- Verify: `npm run build` green; local `npm start` renders.

## Task D4 — Port content

- Port existing ERPBridge `docs/` guides (connectivity, mcp-client-guide) + new pages into `docs/erpbridge/`: intro, quickstart, transports, connectivity, mcp-client-guide, cli, auth (current + planned token auth), api-reference.
- `docs/roadmap/` placeholders for upcoming repos; per-product `sidebars.ts`.
- Verify: `npm run build` green; all internal links resolve.

## Task D5 — CI/CD to GitHub Pages

- `.github/workflows/test-deploy.yml`: PR → `npm ci` + `npm run build`.
- `.github/workflows/deploy.yml`: push main → build + `actions/deploy-pages@v4`.
- Enable Pages via `gh api -X POST repos/nmdra/erpbridge-docs/pages -f build_type=workflow`.
- Verify: workflows green on push; site loads at https://nmdra.github.io/erpbridge-docs/.

## Task D6 — Repo hygiene (done)

- README (local dev), AGENTS.md (global rules: plan first, small commits, quality gates), CHANGELOG.md.
- Verify: `npm run build` green.

## Task D7 — AI agent plugins (done)

- Research `docusaurus-plugin-copy-page-button` and llms.txt generators (rachfop/docusaurus-plugin-llms chosen — build-time only, fits GitHub Pages static output).
- Add both plugins: copy-page-button (generateMarkdownRoutes + ERPBridge MCP server install action), llms (`llms.txt` + `llms-full.txt`, llmstxt.org standard).
- Update README, AGENTS.md content conventions, CHANGELOG.
- Verify: `npm run build` green; `build/llms.txt`, `build/llms-full.txt`, and 44 per-page `.md` routes generated.

## Task D8 — Split Server/Bridgectl docs + MDX conversion (done)

- Move cobra CLI reference into its own `docs/bridgectl/` section; flat layout so generated "SEE ALSO" links keep resolving.
- Add `bridgectlSidebar` in `sidebars.ts` with command groups (api, tool, cache, log, context, other) and a new `overview.mdx` landing page.
- Navbar: rename `ERPBridge` → `Docs`; add `Server` (doc link) and `Bridgectl` (docSidebar) shortcuts; keep `Roadmap`.
- Switch `markdown.format` from `'md'` to `'detect'`: `.mdx` pages get full MDX, generated `.md` CLI docs stay CommonMark-safe.
- Convert all 14 server pages + roadmap to `.mdx`; add `Tabs`, admonitions, `<details>`, code-block titles, keywords/description frontmatter.
- Add `@docusaurus/theme-mermaid` and Mermaid diagrams to the architecture page; reorder the server sidebar.
- Update docs-repo AGENTS.md content conventions and CHANGELOG (Unreleased).
- Verify: `npm run build` + `npm run typecheck` green; live site renders new navbar and both sections (commit 1b55169, deploy run 32244726148 green).

## Task D9 — Apply audit remediation (docs drift from `Report-code-vs-docs-audit.md`) (done)

Source of truth: `.agents/plans/Report-code-vs-docs-audit.md` (section 9.1 + drift catalog D1-D8). All claims verified against ERPBridge code before editing. Order: D9.1 → D9.11; each task = one commit + CHANGELOG (Unreleased) entry; gate = `npm run build` + `npm run typecheck`.

- [x] **D9.1 — Handshake URL** (`docs/erpbridge/transports.mdx:17`, `docs/erpbridge/connectivity.mdx:17`): `POST /mcp/initialize` → `POST /mcp/` (code: server.go:465 accepts JSON-RPC initialize on `/mcp/`).
- [x] **D9.2 — Cache corrections** (`docs/erpbridge/caching.mdx:21,94`): TTL default is 0 (no expiry) not 3600s (manager.go:77); `bridgectl cache flush --tool X` → positional `bridgectl cache flush X` (cli/cache.go:64; module/all flags kept).
- [x] **D9.3 — Prometheus metrics + API envelopes** (`docs/erpbridge/api.mdx`): document all 11 metrics (audit §3.3); add response-envelope examples for `/api/tools/invoke`, `/api/cache/stats`, `/api/cache/flush` and the 422 admission status (audit §3.1).
- [x] **D9.4 — Outbound ERP auth + data redaction** (`docs/erpbridge/auth.mdx`): document `api-key`/`basic`/`bearer` header construction + `credentialRef` env resolution (tool.go:199-203); redacted keys, sensitive types, Bearer regex (logger/mcp_handler.go:32-61).
- [x] **D9.5 — Connector resilience** (`docs/erpbridge/connectivity.mdx`): 15s HTTP timeout, gobreaker circuit breaker (≥5 reqs ∧ ≥60% failures ⇒ open; 30s open window; 3 half-open probes), 3 attempts / 500ms delay / 100ms max jitter retry on network errors + 429/5xx (client.go:44-70,115-150).
- [x] **D9.6 — Onboarding batch apply** (`docs/erpbridge/onboarding.mdx:92,120`): `tool generate` writes individual `.json` files into `schemas/erp/`; drop the `-o yaml > generated.yaml` redirect; recommend `tool apply -f schemas/erp/`.
- [x] **D9.7 — Exit codes + AgentActionableError** (`docs/bridgectl/overview.mdx`): table of codes 0-7 + JSON stdout error payload (cli/errors.go).
- [x] **D9.8 — Tool schema spec completeness** (`docs/erpbridge/tool-schema.mdx`): document `spec.outputSchema` runtime validation (jsonschema/v6), `metadata.isActive`, `spec.lifecycle`, `spec.routing`; fix the `invalidateOn` example + note (schema field is `flushOn`; alias accepted after C5).
- [x] **D9.9 — System tools + notifications** (`docs/erpbridge/mcp-client-guide.mdx`): `system.progress_test`, `system.sensitive_log_test` (server.go:100-171); `notifications/progress` + `notifications/alert` payloads (notifications.go).
- [x] **D9.10 — Env var completeness** (`docs/erpbridge/environment-variables.mdx`): add `MOCK_ERP_LOG_LEVEL` (audit §4.1).
- [x] **D9.11 — Naming/protocol consistency** (`docs/erpbridge/quickstart.mdx:107` tool name `erp.list_employees` → `list_employees`; `docs/erpbridge/mcp-client-guide.mdx` protocolVersion `2024-11-05` → `2025-03-26`).

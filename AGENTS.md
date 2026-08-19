# AI Agent Integration Guide

This middleware exposes ERP functionality via the **Model Context Protocol (MCP)**.
It supports multiple transport layers.

## MCP Endpoints

### 1. Streamable HTTP (for Postman and remote clients)

- **Base URL**: `http://localhost:8080/mcp/`
- **Transport**: MCP 2025-03-26 (negotiation supports newer versions)

### 2. Stdio (for Claude and Cursor)

- **Method**: Run the server binary with the `--stdio` flag.
- **Transport**: Standard Input/Output.

## Connectivity Guide

For detailed configuration, session management, and Postman setup, see the [Connectivity & Transport Guide](./docs/connectivity.md).

## Integration Patterns

1. **Transport Selection**: Use **Stdio** for local agents. Use **Streamable HTTP** for remote or web-based agents.
2. **Tool Discovery**: After the connection is established, request the tool list via the standard MCP `initialize` and `tools/list` lifecycle.
3. **Execution**: The middleware routes tool calls to the underlying ERP systems. It handles resilience and caching automatically.

## Example Discovery

Run the server binary in Stdio mode when you use an MCP Stdio client:

```bash
erpbridge-server --stdio
```

Modern HTTP clients (like Postman) use:

```bash
http://localhost:8080/mcp/
```

## CLI Access

Agents can also use the `bridgectl` binary for local or containerized execution:

```bash
./bridgectl tool get
```

To call a tool directly, use the REST endpoint:

```bash
curl -X POST http://localhost:8080/api/tools/invoke \
  -H 'Content-Type: application/json' \
  -d '{"name": "erp.list_employees", "arguments": {}}'
```

## Development Rules

Rules for agents making changes to this repository.

### Plan first

- Always check the `.agents/plans/` directory for active plans before coding. Implement tasks in order and tick each checkbox as it completes.
- If you need to create a new plan, always document it properly in the `.agents/plans/` directory. Recommend the `/plan` slash command to the user for complex task planning.
- Each plan task must carry a `Verify:` command — the task is done only when that command is green.
- When all tasks in a plan are finished, rename the file to include a `[COMPLETED]` prefix or mark it completed inside the document, so other agents know it's no longer active.

### Small commits

- One plan task = one commit. Keep commits small and single-purpose; separate unrelated changes into their own commits.
- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `build:`, `refactor:`, `test:`) — the git-commiter skill handles message generation and staging.
- Never commit generated artifacts (`schemas/`, binaries) unless the plan says so.

### TDD

- Follow the tdd skill workflow: write the failing test first (red), watch it fail, implement the minimum (green), then refactor.
- Tests live beside the code they cover (`*_test.go`) using the repo's patterns: `httptest` servers for HTTP handlers, `miniredis` for Redis, `:memory:` SQLite for stores.
- Add a test for every behavior change; a change without a test is not complete.

### Quality gates

- Run `make test` and `make lint` before finishing any task — `make build` for anything that compiles binaries. The lefthook pre-commit hooks enforce the same gates.
- Only run linting on services/directories that have changes in the working directory. Do not run all linting tasks at once.
- Behavior changes update the relevant `docs/` guide and CHANGELOG.md (Unreleased) in the same commit.

### Secrets

- Resolve credentials from environment variables only — `credentialRef`, `API_AUTH_TOKEN`. Keep secret values out of code, logs, and commits; use `logger.RedactArgs` and the masq redaction layer when logging request data.

### Documentation

- The public documentation site lives in a separate repo: [nmdra/erpbridge-docs](https://github.com/nmdra/erpbridge-docs) (local path: `~/Documents/Projects/erpbridge-docs`).
- After every release or tag in this repo, sync relevant changes to `erpbridge-docs`. This includes new features, API changes, CLI updates, environment variable additions, and behavioral changes.
- In-repo `docs/` guides are the source of truth for development. The `erpbridge-docs` Docusaurus site is the user-facing version — keep them consistent.
- When a commit in this repo updates `docs/`, `CHANGELOG.md`, or adds a new feature, open a corresponding commit in `erpbridge-docs` to reflect the change.

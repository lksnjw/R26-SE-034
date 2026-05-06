# Agentic Orchestrator Backend

Enterprise-grade Golang backend for the Low-Code Workflow Automation Engine.

It connects the React frontend to:

- Natural-language-to-YAML synthesis through Ollama `phi3:mini`.
- YAML schema validation and semantic RBAC guardrails.
- A sequential process runner with state variable injection.
- A tool registry inspired by Claude Code's tool architecture.
- An MCP middleware bridge for ERP-safe execution.
- Predictive self-healing when external MCP calls fail.

## Run Locally

```bash
go mod tidy
go run ./cmd/server
```

The API starts at:

```text
http://localhost:8080/api
```

Health check:

```text
GET http://localhost:8080/healthz
```

## Development Auth

During local development, set:

```env
ALLOW_DEV_AUTH=true
```

Then pass:

```text
Authorization: Bearer local-dev-token
```

Or call `POST /api/auth/login` and use the returned JWT.

## Implemented API Groups

- `/api/auth`
- `/api/dashboard`
- `/api/workflows`
- `/api/synthesis`
- `/api/chat/sessions`
- `/api/executions`
- `/api/analytics`
- `/api/users`
- `/api/roles`
- `/api/permissions`
- `/api/audit`
- `/api/profile`
- `/api/settings`
- `/api/integrations`
- `/api/notifications`
- `/api/upload`
- `/ws/*`

## Architecture

```text
cmd/server/main.go
  -> Fiber server, CORS, logger, routes

internal/api
  -> HTTP handlers, route aggregation, auth/RBAC/logger middleware

internal/core/synthesizer
  -> strict prompt generation and Ollama client

internal/core/validator
  -> YAML schema validation and semantic policy gate

internal/core/runner
  -> sequential execution loop and state manager

internal/core/healing
  -> LLM repair loop for failed MCP executions

internal/tools
  -> Tool interface, registry, MCP bridge, ERP tool implementations

internal/repository
  -> in-memory repository seeded with frontend-compatible data

pkg/parser
  -> YAML parse/stringify/checksum and `{{variable}}` injection
```

## Production Swap Points

The backend currently uses in-memory repositories so the full frontend can connect immediately. Replace these boundaries for production:

- `internal/repository`: PostgreSQL-backed workflow, audit, execution, user, and settings storage.
- `internal/config/db.go`: real Postgres pool.
- `internal/config/redis.go`: real Redis policy cache.
- `internal/tools/mcp_client.go`: set `MCP_BASE_URL` to Dharmasiri's middleware.
- `internal/core/synthesizer/ollama_client.go`: set `OLLAMA_ENABLED=true` after pulling `phi3:mini`.

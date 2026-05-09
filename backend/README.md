# Agentic Orchestrator Backend

Enterprise-grade Golang backend for the Low-Code Workflow Automation Engine.

It connects the React frontend to:

- Dataset-backed embedding semantic retrieval over tools, rules, templates, and examples.
- Gemini API workflow YAML candidate generation.
- Multi-candidate YAML generation, registry validation, scoring, and best-candidate selection.
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

## Chat Orchestration Pipeline

`POST /api/chat/sessions/:id/messages` accepts a natural-language workflow request using either `content` or the older `message` field. The backend calls the embedding semantic search service, retrieves tools/rules/templates/examples, builds a controlled Gemini prompt, generates multiple YAML candidates, validates each candidate against the full registry, and returns the selected valid YAML only when `can_execute=true`.

Useful local configuration:

```env
DATASET_ROOT=./dataset
SEMANTIC_SEARCH_MODE=external_embedding
SEMANTIC_SEARCH_URL=http://localhost:8090/search
SEMANTIC_SEARCH_TOP_K_TOOLS=10
SEMANTIC_SEARCH_TOP_K_RULES=15
SEMANTIC_SEARCH_TOP_K_TEMPLATES=5
SEMANTIC_SEARCH_TOP_K_EXAMPLES=5
SEMANTIC_SEARCH_ALLOW_LEXICAL_FALLBACK=false
WORKFLOW_GENERATION_PROVIDER=gemini
GEMINI_MODEL=gemini-1.5-flash
CANDIDATE_COUNT=5
```

Full notes are in `docs/CHAT_EMBEDDING_SEARCH_GEMINI_PIPELINE.md`.

## Run Embedding Search Service

```powershell
ollama pull nomic-embed-text
cd semantic_search_service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:DATASET_ROOT="..\dataset"
$env:EMBEDDING_PROVIDER="ollama"
$env:OLLAMA_EMBEDDING_BASE_URL="http://localhost:11434"
$env:OLLAMA_EMBEDDING_MODEL="nomic-embed-text"
$env:INDEX_PROFILE="dev"
$env:INDEX_MAX_ITEMS_PER_FILE="25"
$env:EMBED_BATCH_SIZE="32"
$env:EMBEDDING_TEXT_MAX_CHARS="2000"
$env:REBUILD_SEMANTIC_INDEX="false"
$env:INDEX_INCLUDE_TOOLS="true"
$env:INDEX_INCLUDE_RULES="true"
$env:INDEX_INCLUDE_TEMPLATES="true"
$env:INDEX_INCLUDE_EXAMPLES="true"
$env:INDEX_INCLUDE_VALIDATOR_CASES="false"
uvicorn app:app --host 127.0.0.1 --port 8090
```

Then start the Go backend in another terminal. Gemini is not used for semantic search; Gemini is used only for YAML workflow generation.

The first semantic-search startup creates a persistent FAISS/embedding cache under `semantic_search_service/.cache`. Later startups load from cache when the dataset/config fingerprint is unchanged. Check `http://127.0.0.1:8090/index/status`.

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
  -> strict Gemini prompt generation and candidate parsing

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
- `semantic_search_service`: replace in-memory FAISS with a persistent vector index if needed.

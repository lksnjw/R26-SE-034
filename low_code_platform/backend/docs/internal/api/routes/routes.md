# API Routing (`internal/api/routes/routes.go`)

The `routes.go` file defines the entire URL structure and endpoint mapping for the Agentic Workflow Engine API.

## Design Pattern

The routing is centralized in a `Register` function that takes a Fiber `*App` and a pointer to the main `Handler`. This allows for clean dependency injection and easy navigation of available endpoints.

## Endpoint Groups

### Public Endpoints
*   `/healthz`: Basic system health check.
*   `/ws/*`: WebSocket entry point for real-time events.
*   `/api/auth/*`: Authentication endpoints (Login, Register, Password Reset, OAuth).

### Protected Endpoints (Require JWT)
All following routes are grouped under the `Auth` middleware:

*   **Auth Management**: Logout, User Profile (`/me`), 2FA Management.
*   **Dashboard**: High-level summaries, activity logs, and system health metrics.
*   **Workflows**: 
    *   CRUD operations for workflows.
    *   Versioning and restoration.
    *   Template management.
    *   Validation and execution triggers.
    *   Canvas and YAML data persistence.
*   **Synthesis & AI**:
    *   LLM-based workflow synthesis.
    *   Semantic search for tools and rules.
    *   Catalog discovery.
*   **Chat**: Management of conversational sessions and message history.
*   **Executions**: Detailed tracking of workflow runs, including logs, timelines, and healing reports.
*   **Analytics**: Performance metrics, usage trends, and cost analysis.
*   **Administration**: User and Role management, permission matrices, and audit log exports.
*   **Settings & Integrations**: System configuration, LLM settings, and external integration management (Webhooks, etc.).

## Interactions

*   **Handlers**: Every route maps to a specific method on the `Handler` struct in `internal/api/handlers/`.
*   **Middlewares**: Uses `Auth` to secure the majority of the API and can be extended with RBAC middlewares for specific sensitive routes.

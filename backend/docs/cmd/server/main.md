# Server Main Entry Point (`cmd/server/main.go`)

The `main.go` file in `cmd/server/` is the entry point of the Agentic Workflow Engine backend application. It is responsible for bootstrapping the entire system, initializing services, and starting the HTTP server.

## Key Responsibilities

1.  **Configuration Loading**: Loads environment variables using the `internal/config` package, supporting multiple `.env` files.
2.  **Logger Initialization**: Sets up a structured logger using `uber-go/zap` based on the environment (development or production).
3.  **Data Stores**: Initializes database and cache adapters. While currently operating in memory-mode for development, it is designed for a seamless swap to PostgreSQL and Redis.
4.  **Core Service Bootstrapping**:
    *   **Synthesizer**: Configures the LLM service (Gemini or Ollama) for workflow generation.
    *   **Registry**: Loads tool and rule registries from the dataset or specific configuration paths.
    *   **Semantic Search**: Initializes the search service for tool and rule discovery.
    *   **Chat Orchestrator**: Sets up the high-level component that manages the flow from natural language requests to executable workflows.
5.  **Tool Registration**: Registers built-in tools (e.g., Attendance, Leave) and generic MCP (Model Context Protocol) tools into the system registry.
6.  **Server Configuration**:
    *   Initializes a **Fiber** application.
    *   Configures a custom error handler to return standardized JSON responses.
    *   Sets up **CORS** middleware for frontend communication.
    *   Injects a request logging middleware.
7.  **Routing**: Delegates API route registration to the `internal/api/routes` package.
8.  **Lifecycle Management**: Starts the HTTP server and handles fatal errors during startup or execution.

## Interactions

*   **`internal/config`**: To retrieve application settings.
*   **`internal/core/*`**: To initialize the engine's core logic (orchestration, validation, execution).
*   **`internal/api/routes`**: To set up the API endpoints.
*   **`internal/api/handlers`**: To create the main handler container with all required dependencies.
*   **`pkg/logger`**: To provide structured logging across the application.

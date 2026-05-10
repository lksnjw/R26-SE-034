# Configuration Management (`internal/config/`)

The `internal/config/` package is responsible for managing the application's environment-specific settings, database connections, and cache adapters.

## Files

### `config.go`

This is the core of the configuration package. It defines the `Config` struct, which contains all parameters required by the application, from server settings to LLM provider details.

*   **`Load()`**: The primary function that:
    *   Uses `godotenv` to load `.env` files (supporting `.env.local`, `.env.development`, etc.).
    *   Auto-detects the backend root directory to resolve relative paths for registries and datasets.
    *   Parses environment variables into the `Config` struct with sensible defaults.
*   **Settings include**:
    *   Server host/port and API base path.
    *   JWT secrets and token TTL.
    *   LLM configuration (Ollama and Gemini).
    *   Semantic search parameters (URLs, thresholds, and fallback modes).
    *   Paths for tool and rule registries.

### `db.go`

Handles the initialization of the database adapter.

*   **Current State**: In the current development phase, it initializes an in-memory repository store.
*   **Design**: It is architected to be a drop-in replacement for a PostgreSQL connection, allowing for easy migration to a persistent database.

### `redis.go`

Handles the initialization of the Redis cache adapter.

*   **Current State**: Similar to `db.go`, it currently uses an in-memory policy cache.
*   **Design**: Provides the infrastructure to integrate Redis for distributed caching and session management.

## Key Functions & Responsibilities

*   **Path Resolution**: The package ensures that paths for datasets and configuration files are correctly resolved regardless of whether the app is run from the root or the `backend/` directory.
*   **Typed Access**: Provides typed access (ints, bools, durations) to environment variables, reducing parsing logic in other parts of the system.
*   **Development Support**: Includes flags like `ALLOW_DEV_AUTH` to simplify local development and testing.

# Internal Repository

This directory manages data persistence and retrieval for the workflow engine. The current implementation primarily uses an in-memory store, designed to be easily replaced by a persistent database (e.g., PostgreSQL) in production.

## Core Files

### `memory.go` (The In-Memory Store)
The `Store` struct in `memory.go` serves as the central repository for all system data during the application's lifecycle.
- **Thread Safety**: Uses `sync.RWMutex` to ensure safe concurrent access from multiple API requests and execution threads.
- **Data Structures**: Uses Go maps to store models indexed by their IDs (e.g., `Users`, `Workflows`, `Executions`).
- **Initialization**: The `NewStore()` function bootstraps the system with default permissions, roles, users, and several sample workflows and templates (e.g., "ERP Invoice Exception Resolver").
- **Utility Methods**:
  - `NextID(prefix)`: Generates a new unique ID with a given prefix.
  - `Audit(...)`: A helper to create and store audit logs.
  - `ListMapValues[T](...)`: A generic helper to convert map values into a slice.
  - `FilterWorkflows(...)`: Implements searching and filtering logic for workflows.

### `audit_repo.go`
Currently, this file acts as a placeholder and documentation for audit persistence. In the current version, audit logs are stored in the in-memory `Store.AuditLogs` map. In production, this would interface with an immutable table or an event stream.

### `workflow_repo.go`
Similar to `audit_repo.go`, this file marks the boundary for workflow persistence. It indicates where SQL queries or ORM logic would be implemented to replace the current in-memory maps.

## How Data is Persisted and Retrieved

1. **In-Memory Lifecycle**: All data is stored in RAM. Restarting the server resets the state to the defaults defined in `NewStore()`.
2. **Access Pattern**: The `Store` is usually injected into API handlers or core services. Consumers use the maps directly or via helper methods for CRUD operations.
3. **Concurrency**: All writes to the store must acquire a lock (`store.Mu.Lock()`), while reads should use a read-lock (`store.Mu.RLock()`).
4. **Transition to Persistent Storage**: The architecture is designed such that the `Store` maps can be replaced with database repository implementations that satisfy the same logical requirements. The separation of models (`internal/models`) from storage (`internal/repository`) facilitates this transition.

## Development Roles
The `ApplyDevUserRole` function allows for dynamic modification of the primary admin user's permissions during development or testing, enabling quick swaps between different RBAC scenarios.

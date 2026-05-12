# Internal Models

This directory contains the core data structures and domain models used throughout the Agentic Workflow Engine. These models define the schema for API responses, system settings, execution state, user management, and workflow definitions.

## Core Files

### `api.go`
Defines the standard structures for API communication.
- **`APIResponse`**: A generic wrapper for all API responses, ensuring consistency in `Success`, `Data`, `Message`, and `Meta` fields.
- **`PaginationMeta`**: Standard metadata for paginated list results.
- **`Principal`**: Represents an identity (user or system) performing an action.
- **`Auth` Models**: Includes `LoginRequest`, `RegisterRequest`, `TokenPair`, and `AuthSession` for authentication flows.
- **`ValidationResult`**: Captures the output of workflow validation, including errors, warnings, and specific rule checks.

### `settings.go`
Manages system-wide configurations and session-related models.
- **`SettingsBundle`**: A container for `General`, `LLM`, and `RBAC` settings stored as maps.
- **`Integration`**: Represents external system connections (e.g., MCP servers, GitHub).
- **`Webhook`**: Defines outgoing webhook configurations for system events.
- **`ChatSession` & `ChatMessage`**: Models for the conversational interface used to build and modify workflows.

### `state.go`
Defines the runtime state and execution tracking models.
- **`RunnerState`**: Holds the ephemeral state of a running workflow, including variables and execution IDs.
- **`Execution`**: The primary record of a workflow run, tracking status, duration, token usage, and cost.
- **`ExecutionLog`**: Individual log entries associated with a specific execution and node.
- **`ExecutionStep`**: Represents the lifecycle of a single node within an execution timeline.
- **`HealingReport`**: Contains details about self-healing actions taken during an execution failure.

### `user.go`
Handles identity and access management (IAM) structures.
- **`User`**: The core user model, including role references, permissions, and status.
- **`Role` & `Permission`**: Define the RBAC (Role-Based Access Control) hierarchy.
- **`AuditLog`**: Records immutable actions performed by actors on resources.
- **`APIKey`**: Models for programmatic access to the engine.

### `workflow.go`
The foundation of the engine, defining how workflows are structured and stored.
- **`WorkflowBlueprint`**: The high-level YAML-compatible structure used for importing/exporting workflows.
- **`Workflow`**: The primary database model for a workflow, including metadata like success rates and versions.
- **`WorkflowCanvas`**: Defines the visual representation of a workflow, containing `Nodes` and `Edges`.
- **`WorkflowNode`**: A single step in the canvas, containing configuration and type information.
- **`WorkflowVersion`**: Tracks the history of changes to a workflow's definition.

## Summary of Core Data Structures

| Model | Purpose |
|-------|---------|
| `Workflow` | The central entity representing an automation process. |
| `Execution` | A single instance of a workflow being run. |
| `User` | An authenticated entity with specific permissions. |
| `Store` | (In-memory) The current implementation of the data persistence layer. |
| `Tool` | An interface for actions that can be executed within a workflow step. |

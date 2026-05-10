# Workflow Runner & Execution

The `internal/core/runner` package is responsible for the actual execution of validated workflow blueprints.

## Executor (`executor.go`)

The `Executor` manages the lifecycle of a workflow execution. It handles:
- **State Initialization**: Setting up the `StateManager` with initial input variables.
- **Sequential Step Execution**: Iterating through the steps defined in the blueprint.
- **Parameter Resolution**: Resolving dynamic variables (e.g., `{{step_id.output}}`) using the `StateManager`.
- **Tool Invocation**: Fetching the tool from the `tools.Registry` and executing it.
- **State Updates**: Saving tool outputs back to the execution state.
- **Logging & Auditing**: Recording detailed logs and timeline entries for each step.

## State Manager (`state_manager.go`)

The `StateManager` provides a thread-safe way to manage execution state. It stores:
- Input variables from the user request.
- Outputs from previously executed steps.
- Calculated intermediate values.

It uses a simple key-value store with support for nested parameter resolution.

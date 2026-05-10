# Internal Tools

The `tools` directory contains the framework for defining, registering, and executing actions within a workflow. These tools act as the "hands" of the engine, allowing it to interact with external systems.

## Core Framework

### `tool_interface.go`
Defines the standard `Tool` interface that all actions must implement:
```go
type Tool interface {
    Name() string
    Description() string
    Execute(ctx context.Context, params map[string]interface{}) (map[string]interface{}, error)
}
```
This abstraction allows the workflow runner to execute any tool without knowing its internal implementation details.

### `registry.go`
The `Registry` is a thread-safe container for all available tools.
- **Registration**: Tools are added to the registry during system startup.
- **Lookup**: The registry provides a `Get(name)` method to retrieve a tool by its unique name.
- **Fallback**: It supports a fallback tool (usually a `GenericMCPTool`) that can handle requests for tools that aren't explicitly registered.

### `mcp_client.go`
The **Model Context Protocol (MCP)** client is a bridge to external services.
- **`MCPClient`**: Communicates with an external MCP middleware via HTTP POST. It sends an `action` and `parameters` and receives a JSON response.
- **`GenericMCPTool`**: A catch-all tool implementation that forwards any action request to the MCP middleware. This allows for dynamic tool expansion without changing the backend code.
- **Mocking**: If `MCP_BASE_URL` is empty, the client returns deterministic mock results for development and testing.

## Tool Implementations (`impl/`)

Specific tools are implemented as structs that wrap the `MCPClient` and implement the `Tool` interface.

### `fetch_attendance.go`
- **Action**: `fetch_attendance`
- **Purpose**: Retrieves employee attendance records from the connected ERP system via the MCP middleware.

### `create_leave.go`
- **Action**: `create_leave`
- **Purpose**: Submits a leave request to the ERP system via the MCP middleware.

## How to Implement a New Tool

To add a new tool to the engine:

1. **Create the Implementation**: Create a new file in `internal/tools/impl/`.
   ```go
   type MyNewTool struct {
       MCP *tools.MCPClient
   }
   func (t MyNewTool) Name() string { return "my_action" }
   func (t MyNewTool) Description() string { return "Does something cool" }
   func (t MyNewTool) Execute(ctx context.Context, params map[string]interface{}) (map[string]interface{}, error) {
       return t.MCP.Execute(ctx, t.Name(), params)
   }
   ```
2. **Register the Tool**: In the main server setup (e.g., `cmd/server/main.go`), instantiate your tool and call `registry.Register(myTool)`.
3. **Use in Workflow**: Add a step in your workflow YAML with `action: my_action`.

Alternatively, if the tool is already supported by your MCP middleware, you may not need a dedicated implementation; the `GenericMCPTool` will handle it automatically as long as the action name matches.

# Tool Implementations

This directory contains individual tool implementations that adhere to the `Tool` interface defined in `internal/tools`. Most of these tools are wrappers around the **MCP (Model Context Protocol) Client**, facilitating communication with external services.

## Available Tools

### `FetchAttendanceTool` (`fetch_attendance.go`)
- **Name**: `fetch_attendance`
- **Interface**: `tools.Tool`
- **Description**: Connects to the ERP MCP middleware to retrieve attendance records for a given user or time period.
- **Parameters**: Typically expects `userId`, `startDate`, and `endDate`.

### `CreateLeaveTool` (`create_leave.go`)
- **Name**: `create_leave`
- **Interface**: `tools.Tool`
- **Description**: Submits a leave application to the ERP system via the MCP middleware.
- **Parameters**: Typically expects `userId`, `leaveType`, `startDate`, and `endDate`.

## Implementation Pattern

All tools in this directory follow a consistent pattern:
1. Define a struct that holds a reference to the `MCPClient`.
2. Implement `Name()` to return the unique action identifier.
3. Implement `Description()` to provide a human-readable summary.
4. Implement `Execute()` to delegate the action to the `MCPClient.Execute` method.

Example:
```go
func (t CreateLeaveTool) Execute(ctx context.Context, params map[string]interface{}) (map[string]interface{}, error) {
    return t.MCP.Execute(ctx, t.Name(), params)
}
```

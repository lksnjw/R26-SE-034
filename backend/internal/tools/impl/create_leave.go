package impl

import (
	"context"

	"github.com/sanjeewa/agentic-orchestrator/internal/tools"
)

type CreateLeaveTool struct {
	MCP *tools.MCPClient
}

func (t CreateLeaveTool) Name() string {
	return "create_leave"
}

func (t CreateLeaveTool) Description() string {
	return "Creates a leave request through the ERP MCP middleware."
}

func (t CreateLeaveTool) Execute(ctx context.Context, params map[string]interface{}) (map[string]interface{}, error) {
	return t.MCP.Execute(ctx, t.Name(), params)
}

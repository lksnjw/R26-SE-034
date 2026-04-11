package tools

import "context"

type Tool interface {
	Name() string
	Description() string
	Execute(ctx context.Context, params map[string]interface{}) (map[string]interface{}, error)
}

type ToolResult struct {
	Action string                 `json:"action"`
	Result map[string]interface{} `json:"result"`
}

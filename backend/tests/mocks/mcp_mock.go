package mocks

import "context"

type MCPMock struct{}

func (MCPMock) Execute(ctx context.Context, action string, params map[string]interface{}) (map[string]interface{}, error) {
	return map[string]interface{}{"action": action, "parameters": params, "mock": true}, nil
}

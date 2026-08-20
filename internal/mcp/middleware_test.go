package mcp

import (
	"context"
	"testing"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/stretchr/testify/assert"
)

func TestRateLimitMiddleware(t *testing.T) {
	// 2 req/s, burst 1
	m := NewRateLimitMiddleware(2, 1)
	handler := m.Handle()(func(_ context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return mcp.NewToolResultText("ok"), nil
	})

	ctx := context.Background()
	req := mcp.CallToolRequest{}
	req.Params.Name = testString

	// First request - allowed
	res, err := handler(ctx, req)
	assert.NoError(t, err)
	assert.False(t, res.IsError)

	// Second request - blocked (burst is 1)
	res, err = handler(ctx, req)
	assert.NoError(t, err)
	assert.True(t, res.IsError)
	assert.Contains(t, res.Content[0].(mcp.TextContent).Text, "rate limit exceeded")
}

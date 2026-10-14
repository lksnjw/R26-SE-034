package mcp

import (
	"bytes"
	"encoding/json"
	"testing"

	protocolmcp "github.com/mark3labs/mcp-go/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type partialWriter struct {
	bytes.Buffer
	max int
}

func (w *partialWriter) Write(p []byte) (int, error) {
	if len(p) > w.max {
		p = p[:w.max]
	}
	return w.Buffer.Write(p)
}

func TestToolListFilterWriter_FiltersPartialRecords(t *testing.T) {
	var output partialWriter
	output.max = 3
	writer := NewToolListFilterWriter(&output, func(tools []protocolmcp.Tool) []protocolmcp.Tool {
		filtered := make([]protocolmcp.Tool, 0, len(tools))
		for _, tool := range tools {
			if tool.Name != "inactive" {
				filtered = append(filtered, tool)
			}
		}
		return filtered
	})

	message := map[string]any{
		"jsonrpc": "2.0",
		"id":      1,
		"result": map[string]any{
			"tools": []map[string]any{
				{testFieldName: "active"},
				{testFieldName: "inactive"},
			},
		},
	}
	payload, err := json.Marshal(message)
	require.NoError(t, err)
	payload = append(payload, '\n')

	for start := 0; start < len(payload); start += 2 {
		end := min(start+2, len(payload))
		written, err := writer.Write(payload[start:end])
		require.NoError(t, err)
		require.Equal(t, end-start, written)
	}

	var filtered map[string]any
	require.NoError(t, json.Unmarshal(output.Bytes(), &filtered))
	tools := filtered["result"].(map[string]any)["tools"].([]any)
	require.Len(t, tools, 1)
	assert.Equal(t, "active", tools[0].(map[string]any)[testFieldName])
}

func TestToolListFilterWriter_PassesNotificationsAndMalformedRecords(t *testing.T) {
	var output bytes.Buffer
	writer := NewToolListFilterWriter(&output, func(_ []protocolmcp.Tool) []protocolmcp.Tool { return nil })
	notification := []byte(`{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}`)
	malformed := []byte(`not-json`)

	_, err := writer.Write(append(append(notification, '\n'), append(malformed, '\n')...))
	require.NoError(t, err)
	assert.Contains(t, output.String(), string(notification))
	assert.Contains(t, output.String(), string(malformed))
}

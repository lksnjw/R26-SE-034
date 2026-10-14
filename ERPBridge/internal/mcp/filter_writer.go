package mcp

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"sync"

	protocolmcp "github.com/mark3labs/mcp-go/mcp"
)

// ToolListFilterWriter filters tools/list responses in newline-delimited JSON
// streams while passing notifications and unrelated records through unchanged.
type ToolListFilterWriter struct {
	mu      sync.Mutex
	out     io.Writer
	filter  func([]protocolmcp.Tool) []protocolmcp.Tool
	pending []byte
}

// NewToolListFilterWriter creates a Stdio-safe output adapter.
func NewToolListFilterWriter(out io.Writer, filter func([]protocolmcp.Tool) []protocolmcp.Tool) *ToolListFilterWriter {
	return &ToolListFilterWriter{out: out, filter: filter}
}

// Write buffers partial records and emits complete newline-delimited records.
func (w *ToolListFilterWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	w.pending = append(w.pending, p...)
	for {
		lineEnd := bytes.IndexByte(w.pending, '\n')
		if lineEnd < 0 {
			break
		}
		line := append([]byte(nil), w.pending[:lineEnd]...)
		w.pending = w.pending[lineEnd+1:]
		line = filterToolListRecord(line, w.filter)
		if err := writeAll(w.out, append(line, '\n')); err != nil {
			return len(p), err
		}
	}
	return len(p), nil
}

func filterToolListRecord(line []byte, filter func([]protocolmcp.Tool) []protocolmcp.Tool) []byte {
	if filter == nil || len(bytes.TrimSpace(line)) == 0 {
		return line
	}
	var message map[string]json.RawMessage
	if err := json.Unmarshal(line, &message); err != nil {
		return line
	}
	resultRaw, ok := message["result"]
	if !ok {
		return line
	}
	var result map[string]json.RawMessage
	if err := json.Unmarshal(resultRaw, &result); err != nil {
		return line
	}
	toolsRaw, ok := result["tools"]
	if !ok {
		return line
	}
	var tools []protocolmcp.Tool
	if err := json.Unmarshal(toolsRaw, &tools); err != nil {
		return line
	}
	filtered := filter(tools)
	filteredRaw, err := json.Marshal(filtered)
	if err != nil {
		return line
	}
	result["tools"] = filteredRaw
	resultRaw, err = json.Marshal(result)
	if err != nil {
		return line
	}
	message["result"] = resultRaw
	filteredMessage, err := json.Marshal(message)
	if err != nil {
		return line
	}
	return filteredMessage
}

func writeAll(out io.Writer, payload []byte) error {
	for len(payload) > 0 {
		written, err := out.Write(payload)
		if written > 0 {
			payload = payload[written:]
		}
		if err != nil {
			return err
		}
		if written == 0 {
			return fmt.Errorf("output writer made no progress")
		}
	}
	return nil
}

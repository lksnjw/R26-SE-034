package mcp

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/nimendra/ERPBridge/internal/logger"
	"github.com/stretchr/testify/assert"
)

func TestServer_ToolAPI(t *testing.T) {
	log := logger.Init()
	s := NewServer(nil, nil, log, RateLimitConfig{RequestsPerSecond: 100, Burst: 100}, ":memory:")

	t.Run("Apply Valid Tool", func(t *testing.T) {
		toolJSON := testToolJSON
		req := httptest.NewRequest(http.MethodPost, "/apis/erpbridge.io/v1/tools", bytes.NewBufferString(toolJSON))
		w := httptest.NewRecorder()
		s.handleToolAPI(w, req)
		assert.Equal(t, http.StatusCreated, w.Code)
		assert.Contains(t, w.Body.String(), `"status":"applied"`)
	})

	t.Run("Apply Invalid Tool - Bad JSON", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/apis/erpbridge.io/v1/tools", bytes.NewBufferString(`{bad`))
		w := httptest.NewRecorder()
		s.handleToolAPI(w, req)
		assert.Equal(t, http.StatusBadRequest, w.Code)
	})

	t.Run("Apply Invalid Tool - Validation Failed (Missing Name)", func(t *testing.T) {
		toolJSON := `{"metadata":{"name":"","version":"1.0.0"}}`
		req := httptest.NewRequest(http.MethodPost, "/apis/erpbridge.io/v1/tools", bytes.NewBufferString(toolJSON))
		w := httptest.NewRecorder()
		s.handleToolAPI(w, req)
		assert.Equal(t, http.StatusUnprocessableEntity, w.Code)
	})

	t.Run("Apply Invalid Tool - Validation Failed (Missing Version)", func(t *testing.T) {
		toolJSON := `{"metadata":{"name":"test-tool","version":""}}`
		req := httptest.NewRequest(http.MethodPost, "/apis/erpbridge.io/v1/tools", bytes.NewBufferString(toolJSON))
		w := httptest.NewRecorder()
		s.handleToolAPI(w, req)
		assert.Equal(t, http.StatusUnprocessableEntity, w.Code)
	})

	t.Run("Apply Invalid Tool - Validation Failed (Secrets key)", func(t *testing.T) {
		toolJSON := `{"metadata":{"name":"test-sec","version":"1.0.0"},"spec":{"description":{"short":"test"},"execution":{"endpoint":"http://a.com?key=123"}}}`
		req := httptest.NewRequest(http.MethodPost, "/apis/erpbridge.io/v1/tools", bytes.NewBufferString(toolJSON))
		w := httptest.NewRecorder()
		s.handleToolAPI(w, req)
		assert.Equal(t, http.StatusUnprocessableEntity, w.Code)
	})

	t.Run("Apply Invalid Tool - Validation Failed (Secrets token)", func(t *testing.T) {
		toolJSON := `{"metadata":{"name":"test-sec-token","version":"1.0.0"},"spec":{"description":{"short":"test"},"execution":{"endpoint":"http://a.com token 123"}}}`
		req := httptest.NewRequest(http.MethodPost, "/apis/erpbridge.io/v1/tools", bytes.NewBufferString(toolJSON))
		w := httptest.NewRecorder()
		s.handleToolAPI(w, req)
		assert.Equal(t, http.StatusUnprocessableEntity, w.Code)
	})

	t.Run("Apply Invalid Tool - Validation Failed (HTTP verbs)", func(t *testing.T) {
		toolJSON := `{"metadata":{"name":"get-users","version":"1.0.0"}}`
		req := httptest.NewRequest(http.MethodPost, "/apis/erpbridge.io/v1/tools", bytes.NewBufferString(toolJSON))
		w := httptest.NewRecorder()
		s.handleToolAPI(w, req)
		assert.Equal(t, http.StatusUnprocessableEntity, w.Code)
	})

	t.Run("List Tools", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/apis/erpbridge.io/v1/tools", nil)
		w := httptest.NewRecorder()
		s.handleToolAPI(w, req)
		assert.Equal(t, http.StatusOK, w.Code)
		assert.Contains(t, w.Body.String(), `"name":"test-tool"`)
	})

	t.Run("Delete Tool", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodDelete, "/apis/erpbridge.io/v1/tools?name=test-tool&version=1.0.0", nil)
		w := httptest.NewRecorder()
		s.handleToolAPI(w, req)
		assert.Equal(t, http.StatusNoContent, w.Code)
	})

	t.Run("Delete Tool - Missing Params", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodDelete, "/apis/erpbridge.io/v1/tools", nil)
		w := httptest.NewRecorder()
		s.handleToolAPI(w, req)
		assert.Equal(t, http.StatusBadRequest, w.Code)
	})

	t.Run("Method Not Allowed", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPut, "/apis/erpbridge.io/v1/tools", nil)
		w := httptest.NewRecorder()
		s.handleToolAPI(w, req)
		assert.Equal(t, http.StatusMethodNotAllowed, w.Code)
	})
}

func TestServer_Reconcile_And_Deregister(t *testing.T) {
	log := logger.Init()
	s := NewServer(nil, nil, log, RateLimitConfig{RequestsPerSecond: 100, Burst: 100}, ":memory:")

	// Add a tool to the store
	tool := &Tool{
		Metadata: Metadata{Name: "recon-tool", Version: testVersion100, IsActive: true},
		Spec:     ToolSpec{Description: Description{Short: testDescShort}},
	}
	err := s.store.Save(tool)
	assert.NoError(t, err)

	// Call Reconcile
	s.Reconcile(context.Background())

	// Ensure tool is registered
	regTool, err := s.registry.Resolve("recon-tool", testVersion100)
	assert.NoError(t, err)
	assert.NotNil(t, regTool)

	// Call Reconcile again, should do nothing because hash matches
	s.Reconcile(context.Background())

	// Now delete from store and Reconcile, should deregister
	err = s.store.Delete("recon-tool", testVersion100)
	assert.NoError(t, err)

	// Force hash change by waiting a bit
	time.Sleep(100 * time.Millisecond)

	s.Reconcile(context.Background())

	// Ensure tool is deregistered
	_, err = s.registry.Resolve("recon-tool", testVersion100)
	assert.Error(t, err)

	// Call Deregister explicitly
	s.DeregisterTool("nonexistent", testVersion100)
}

func TestServer_StartController(_ *testing.T) {
	log := logger.Init()
	s := NewServer(nil, nil, log, RateLimitConfig{RequestsPerSecond: 100, Burst: 100}, ":memory:")

	ctx, cancel := context.WithCancel(context.Background())

	// Run controller in background
	go s.StartController(ctx)

	// Sleep briefly to let it loop once if possible, or just cancel
	time.Sleep(50 * time.Millisecond)
	cancel()
	time.Sleep(50 * time.Millisecond) // wait for goroutine to exit
}

func TestServer_HandleMCPToolCall(t *testing.T) {
	log := logger.Init()
	s := NewServer(nil, nil, log, RateLimitConfig{RequestsPerSecond: 100, Burst: 100}, ":memory:")

	// Register a tool directly via registry to simulate
	tool := &Tool{
		Metadata: Metadata{Name: "mcp-tool", Version: testVersion100},
		Spec:     ToolSpec{Description: Description{Short: testDescShort}},
		Handler: func(_ context.Context, _ map[string]any) (*ToolResult, error) {
			return &ToolResult{Result: map[string]any{testStatusField: testStatusOk}}, nil
		},
	}
	s.RegisterTool(tool)

	handler := s.handleMCPToolCall("mcp-tool")

	req := mcp.CallToolRequest{}
	req.Params.Name = "mcp-tool"
	req.Params.Arguments = map[string]any{"arg1": "val1"}

	res, err := handler(context.Background(), req)
	assert.NoError(t, err)
	assert.NotNil(t, res)
	assert.False(t, res.IsError)
	assert.Len(t, res.Content, 1)

	textRes := res.Content[0].(mcp.TextContent)
	assert.Contains(t, textRes.Text, `"status":"ok"`)

	// Invalid arguments format
	req.Params.Arguments = "invalid string instead of map"
	_, err = handler(context.Background(), req)
	assert.Error(t, err)

	// Tool not found
	handlerNotFound := s.handleMCPToolCall("nonexistent-tool")
	req.Params.Name = "nonexistent-tool"
	req.Params.Arguments = map[string]any{}
	_, err = handlerNotFound(context.Background(), req)
	assert.Error(t, err)
}

func TestServer_HandleMCPToolCall_ExecuteError(t *testing.T) {
	log := logger.Init()
	s := NewServer(nil, nil, log, RateLimitConfig{RequestsPerSecond: 100, Burst: 100}, ":memory:")

	tool := &Tool{
		Metadata: Metadata{Name: "err-tool", Version: testVersion100},
		Spec:     ToolSpec{Description: Description{Short: testDescShort}},
		Handler: func(_ context.Context, _ map[string]any) (*ToolResult, error) {
			return nil, fmt.Errorf("execute error")
		},
	}
	s.RegisterTool(tool)

	handler := s.handleMCPToolCall("err-tool")
	req := mcp.CallToolRequest{}
	req.Params.Name = "err-tool"
	req.Params.Arguments = map[string]any{}

	res, err := handler(context.Background(), req)
	assert.NoError(t, err) // mcp handler returns nil error, but result has error
	assert.True(t, res.IsError)
	assert.Len(t, res.Content, 1)
	textRes := res.Content[0].(mcp.TextContent)
	assert.Contains(t, textRes.Text, "execute error")
}

func TestServer_ToolAPINoStore(t *testing.T) {
	log := logger.Init()
	s := NewServer(nil, nil, log, RateLimitConfig{RequestsPerSecond: 100, Burst: 100}, "/invalid/path/db")
	s.store = nil // forcibly set nil to test nil store conditions

	t.Run("Apply Tool - No Store", func(t *testing.T) {
		toolJSON := testToolJSON
		req := httptest.NewRequest(http.MethodPost, "/apis/erpbridge.io/v1/tools", bytes.NewBufferString(toolJSON))
		w := httptest.NewRecorder()
		s.handleToolAPI(w, req)
		assert.Equal(t, http.StatusInternalServerError, w.Code)
		assert.Contains(t, w.Body.String(), `store not available`)
	})

	t.Run("Reconcile - No Store", func(_ *testing.T) {
		// Should not panic
		s.Reconcile(context.Background())
	})
}

func TestServer_StoreErrors(t *testing.T) {
	log := logger.Init()
	s := NewServer(nil, nil, log, RateLimitConfig{RequestsPerSecond: 100, Burst: 100}, ":memory:")

	// close store to induce errors
	_ = s.store.Close()

	t.Run("Apply Tool - DB Error", func(t *testing.T) {
		toolJSON := testToolJSON
		req := httptest.NewRequest(http.MethodPost, "/apis/erpbridge.io/v1/tools", bytes.NewBufferString(toolJSON))
		w := httptest.NewRecorder()
		s.handleToolAPI(w, req)
		assert.Equal(t, http.StatusInternalServerError, w.Code)
	})

	t.Run("List Tools - DB Error", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/apis/erpbridge.io/v1/tools", nil)
		w := httptest.NewRecorder()
		s.handleToolAPI(w, req)
		assert.Equal(t, http.StatusInternalServerError, w.Code)
	})

	t.Run("Delete Tool - DB Error", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodDelete, "/apis/erpbridge.io/v1/tools?name=test&version=1", nil)
		w := httptest.NewRecorder()
		s.handleToolAPI(w, req)
		assert.Equal(t, http.StatusInternalServerError, w.Code)
	})

	t.Run("Reconcile - DB Error", func(_ *testing.T) {
		// Should return early due to GetStateHash error
		s.Reconcile(context.Background())
	})
}

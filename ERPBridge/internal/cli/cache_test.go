package cli

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/nmdra/ERPBridge/internal/config"
	"github.com/nmdra/ERPBridge/internal/output"
)

func TestFlushResponse_RenderTable(t *testing.T) {
	resp := &FlushResponse{
		Deleted: 5,
		Status:  "ok",
	}
	var buf bytes.Buffer
	err := resp.RenderTable(&buf)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	out := buf.String()
	if !bytes.Contains([]byte(out), []byte("Deleted 5")) {
		t.Errorf("expected output to contain 'Deleted 5'")
	}
}

func TestCacheStatsCmd(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"keys": 10}`))
	}))
	defer ts.Close()

	cfg = &config.Config{
		CurrentContext: testContextName,
		Contexts: map[string]config.Context{
			testContextName: {Server: ts.URL},
		},
	}
	var buf bytes.Buffer
	formatter = &output.Formatter{Format: output.FormatJSON, Out: &buf}

	cacheStatsCmd.SetContext(context.Background())
	err := cacheStatsCmd.RunE(cacheStatsCmd, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !bytes.Contains(buf.Bytes(), []byte("10")) {
		t.Errorf("expected output to contain 10")
	}
}

func TestCacheFlushCmd(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"deleted": 5, "status": "ok"}`))
	}))
	defer ts.Close()

	cfg = &config.Config{
		CurrentContext: testContextName,
		Contexts: map[string]config.Context{
			testContextName: {Server: ts.URL},
		},
	}
	var buf bytes.Buffer
	formatter = &output.Formatter{Format: output.FormatJSON, Out: &buf}

	cacheFlushCmd.SetContext(context.Background())
	// test no args
	err := cacheFlushCmd.RunE(cacheFlushCmd, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// test args
	err = cacheFlushCmd.RunE(cacheFlushCmd, []string{testToolName})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

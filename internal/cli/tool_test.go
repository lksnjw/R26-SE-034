package cli

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/nimendra/ERPBridge/internal/config"
	"github.com/nimendra/ERPBridge/internal/mcp"
	"github.com/nimendra/ERPBridge/internal/output"
	"github.com/stretchr/testify/require"
)

func TestToolListResponse_RenderTable(t *testing.T) {
	resp := &ToolListResponse{
		Tools: []*mcp.Tool{
			{
				Metadata: mcp.Metadata{
					Name:    testToolName,
					Module:  "hr",
					Version: testToolVersion,
					Status:  testStatusActive,
				},
			},
		},
	}
	var buf bytes.Buffer
	err := resp.RenderTable(&buf)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	out := buf.String()
	if !bytes.Contains([]byte(out), []byte(testToolName)) {
		t.Errorf("expected output to contain 'tool1'")
	}
}

func TestToolGetCmd(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`[{"metadata":{"name":"tool1","version":"1.0"}}]`))
	}))
	defer ts.Close()

	cfg = &config.Config{
		CurrentContext: testContextName,
		Contexts: map[string]config.Context{
			testContextName: {MCPServer: ts.URL},
		},
	}
	var buf bytes.Buffer
	formatter = &output.Formatter{Format: output.FormatJSON, Out: &buf}

	err := toolGetCmd.RunE(toolGetCmd, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !bytes.Contains(buf.Bytes(), []byte(testToolName)) {
		t.Errorf("expected output to contain tool1")
	}
}

func TestToolDeleteCmd_Errors(t *testing.T) {
	err := toolDeleteCmd.Args(toolDeleteCmd, []string{})
	require.Error(t, err)
	require.Contains(t, err.Error(), "missing required arguments")

	err = toolDeleteCmd.Args(toolDeleteCmd, []string{testToolName})
	require.Error(t, err)
	require.Contains(t, err.Error(), "missing required arguments")
}

func TestToolDeleteCmd(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer ts.Close()

	cfg = &config.Config{
		CurrentContext: testContextName,
		Contexts: map[string]config.Context{
			testContextName: {MCPServer: ts.URL},
		},
	}

	t.Run("SoftDelete", func(t *testing.T) {
		toolDeleteCmd.SetContext(context.Background())
		_ = toolDeleteCmd.Flags().Set("hard", "false")
		err := toolDeleteCmd.RunE(toolDeleteCmd, []string{testToolName, testToolVersion})
		require.NoError(t, err)
	})

	t.Run("HardDeleteWithYes", func(t *testing.T) {
		toolDeleteCmd.SetContext(context.Background())
		_ = toolDeleteCmd.Flags().Set("hard", "true")
		_ = toolDeleteCmd.Flags().Set("yes", "true")
		err := toolDeleteCmd.RunE(toolDeleteCmd, []string{testToolName, testToolVersion})
		require.NoError(t, err)
	})
}

func TestToolValidateCmd(t *testing.T) {
	content := `{"metadata":{"name":"t","version":"1"}}`
	err := os.WriteFile("test_tool.json", []byte(content), 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Remove("test_tool.json") }()

	require.NoError(t, toolValidateCmd.Flags().Set("file", "test_tool.json"))
	err = toolValidateCmd.RunE(toolValidateCmd, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

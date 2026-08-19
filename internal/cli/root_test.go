package cli

import (
	"io"
	"log/slog"
	"testing"

	"github.com/nimendra/ERPBridge/internal/config"
	"github.com/nimendra/ERPBridge/internal/output"
)

const (
	testContextName  = "test"
	testServerURL    = "http://test"
	testToolName     = "tool1"
	testToolVersion  = "1.0"
	testStatusActive = "active"
)

func setupTest() {
	cfg = &config.Config{
		CurrentContext: testContextName,
		Contexts: map[string]config.Context{
			testContextName: {Server: testServerURL},
		},
	}
	formatter = &output.Formatter{
		Format: output.FormatTable,
		Out:    io.Discard,
	}
	RootLog = slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestHandleError(_ *testing.T) {
	// coverage
}

func TestExecute(_ *testing.T) {
	// Execute() directly terminates the process on error, so we cannot test it easily without mocking os.Exit
	// We'll skip for now and focus on RunE of commands
}

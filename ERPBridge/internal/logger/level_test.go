// internal/logger/level_test.go
package logger

import (
	"log/slog"
	"testing"

	"github.com/mark3labs/mcp-go/mcp"
)

func TestSlogToMCP(t *testing.T) {
	tests := []struct {
		slogLevel slog.Level
		expected  mcp.LoggingLevel
	}{
		{LevelEmergency, mcp.LoggingLevelEmergency},
		{LevelAlert, mcp.LoggingLevelAlert},
		{LevelCritical, mcp.LoggingLevelCritical},
		{slog.LevelError, mcp.LoggingLevelError},
		{slog.LevelWarn, mcp.LoggingLevelWarning},
		{LevelNotice, mcp.LoggingLevelNotice},
		{slog.LevelInfo, mcp.LoggingLevelInfo},
		{slog.LevelDebug, mcp.LoggingLevelDebug},
		{slog.LevelDebug - 1, mcp.LoggingLevelDebug},
	}

	for _, tt := range tests {
		if got := SlogToMCP(tt.slogLevel); got != tt.expected {
			t.Errorf("SlogToMCP(%v) = %v, want %v", tt.slogLevel, got, tt.expected)
		}
	}
}

func TestMCPToSlog(t *testing.T) {
	tests := []struct {
		mcpLevel mcp.LoggingLevel
		expected slog.Level
	}{
		{mcp.LoggingLevelEmergency, LevelEmergency},
		{mcp.LoggingLevelAlert, LevelAlert},
		{mcp.LoggingLevelCritical, LevelCritical},
		{mcp.LoggingLevelError, slog.LevelError},
		{mcp.LoggingLevelWarning, slog.LevelWarn},
		{mcp.LoggingLevelNotice, LevelNotice},
		{mcp.LoggingLevelInfo, slog.LevelInfo},
		{mcp.LoggingLevelDebug, slog.LevelDebug},
	}

	for _, tt := range tests {
		if got := MCPToSlog(tt.mcpLevel); got != tt.expected {
			t.Errorf("MCPToSlog(%v) = %v, want %v", tt.mcpLevel, got, tt.expected)
		}
	}
}

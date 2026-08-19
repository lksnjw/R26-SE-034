// Package logger provides structured logging, context propagation, and RFC 5424 / MCP logging handlers.
package logger

import (
	"log/slog"

	"github.com/mark3labs/mcp-go/mcp"
)

// RFC 5424 Log Levels
const (
	LevelNotice    = slog.Level(2)
	LevelCritical  = slog.Level(10)
	LevelAlert     = slog.Level(12)
	LevelEmergency = slog.Level(14)
)

// SlogToMCP converts a slog.Level to the MCP protocol's LoggingLevel.
func SlogToMCP(level slog.Level) mcp.LoggingLevel {
	switch {
	case level >= LevelEmergency:
		return mcp.LoggingLevelEmergency
	case level >= LevelAlert:
		return mcp.LoggingLevelAlert
	case level >= LevelCritical:
		return mcp.LoggingLevelCritical
	case level >= slog.LevelError:
		return mcp.LoggingLevelError
	case level >= slog.LevelWarn:
		return mcp.LoggingLevelWarning
	case level >= LevelNotice:
		return mcp.LoggingLevelNotice
	case level >= slog.LevelInfo:
		return mcp.LoggingLevelInfo
	default:
		return mcp.LoggingLevelDebug
	}
}

// MCPToSlog converts a client-requested MCP level back to slog for filtering.
func MCPToSlog(level mcp.LoggingLevel) slog.Level {
	switch level {
	case mcp.LoggingLevelEmergency:
		return LevelEmergency
	case mcp.LoggingLevelAlert:
		return LevelAlert
	case mcp.LoggingLevelCritical:
		return LevelCritical
	case mcp.LoggingLevelError:
		return slog.LevelError
	case mcp.LoggingLevelWarning:
		return slog.LevelWarn
	case mcp.LoggingLevelNotice:
		return LevelNotice
	case mcp.LoggingLevelInfo:
		return slog.LevelInfo
	case mcp.LoggingLevelDebug:
		return slog.LevelDebug
	default:
		return slog.LevelDebug
	}
}

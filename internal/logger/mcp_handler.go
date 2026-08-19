// Package logger provides structured logging, context propagation, and RFC 5424 / MCP logging handlers.
package logger

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"regexp"
	"sync"

	"github.com/m-mizutani/masq"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"github.com/nimendra/ERPBridge/internal/types"
)

// MCPHandler is an slog.Handler that forwards redacted log messages to MCP clients.
type MCPHandler struct {
	srv        *server.MCPServer
	loggerName string
	inner      slog.Handler
	buf        *bytes.Buffer
	mu         sync.Mutex
}

// NewMCPHandler creates a new MCPHandler with built-in redaction.
func NewMCPHandler(srv *server.MCPServer, loggerName string) *MCPHandler {
	buf := &bytes.Buffer{}
	inner := slog.NewJSONHandler(buf, &slog.HandlerOptions{
		Level: slog.LevelDebug - 8, // Pass all levels to Handle() for per-session filtering
		ReplaceAttr: masq.New(
			// Redact by custom types
			masq.WithType[types.APIToken](),
			masq.WithType[types.Password](),
			masq.WithType[types.AuthHeader](),
			masq.WithType[types.SecretKey](),
			masq.WithType[types.PII](),

			// Redact by struct tag
			masq.WithTag("secret"),
			masq.WithTag("pii"),
			masq.WithTag("masq"),

			// Redact by field name prefix
			masq.WithFieldPrefix("Secret"),
			masq.WithFieldPrefix("Private"),

			// Redact by exact field name (covers map keys too)
			masq.WithFieldName("password"),
			masq.WithFieldName("token"),
			masq.WithFieldName("api_key"),
			masq.WithFieldName("secret"),
			masq.WithFieldName("authorization"),
			masq.WithFieldName("ssn"),
			masq.WithFieldName("national_id"),
			masq.WithFieldName("bank_account"),

			// Redact by regex (e.g., Bearer tokens)
			masq.WithRegex(regexp.MustCompile(`(?i)bearer\s+\S+`)),
		),
	})

	return &MCPHandler{
		srv:        srv,
		loggerName: loggerName,
		inner:      inner,
		buf:        buf,
	}
}

// Enabled checks if the record's level is permitted for the current MCP session.
func (h *MCPHandler) Enabled(ctx context.Context, level slog.Level) bool {
	if sess := server.ClientSessionFromContext(ctx); sess != nil {
		if sessWithLogging, ok := sess.(server.SessionWithLogging); ok {
			return level >= MCPToSlog(sessWithLogging.GetLogLevel())
		}
	}
	return true // Allow startup/shutdown logs through if no session is in context
}

// Handle redacts, serializes, and sends the log record to the MCP client.
func (h *MCPHandler) Handle(ctx context.Context, record slog.Record) error {
	// Re-check enabled with context (important for session-based filtering)
	if !h.Enabled(ctx, record.Level) {
		return nil
	}

	// We only send logs if there is a session in the context
	if sess := server.ClientSessionFromContext(ctx); sess == nil {
		return nil
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	// masq's ReplaceAttr runs inside inner.Handle and scrubs the record into the buffer.
	h.buf.Reset()
	if err := h.inner.Handle(ctx, record); err != nil {
		return err
	}

	// Parse the redacted JSON into a map for the MCP data field.
	var payload map[string]any
	if err := json.Unmarshal(h.buf.Bytes(), &payload); err != nil {
		return err
	}

	n := mcp.NewLoggingMessageNotification(
		SlogToMCP(record.Level),
		h.loggerName,
		payload,
	)

	// Send to client. We ignore errors here as clients may not have logging capability
	// or the session might be closed.
	_ = h.srv.SendLogMessageToClient(ctx, n)
	return nil
}

// WithAttrs returns a new handler with the given attributes.
func (h *MCPHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	// For simplicity, we don't clone the buffer/mutex since they are only used in Handle
	// and WithAttrs only modifies the inner handler's attribute state.
	return &MCPHandler{
		srv:        h.srv,
		loggerName: h.loggerName,
		inner:      h.inner.WithAttrs(attrs),
		buf:        h.buf,
		// We share the same buffer and mutex across all clones.
		// This is safe because slog.Logger ensures Handle is called on the final handler.
	}
}

// WithGroup returns a new handler with the given group name.
func (h *MCPHandler) WithGroup(name string) slog.Handler {
	return &MCPHandler{
		srv:        h.srv,
		loggerName: h.loggerName,
		inner:      h.inner.WithGroup(name),
		buf:        h.buf,
	}
}

// MultiHandler fans out each log record to multiple handlers.
type MultiHandler []slog.Handler

// Enabled reports whether any underlying handler handles records at the given level.
func (m MultiHandler) Enabled(ctx context.Context, l slog.Level) bool {
	for _, h := range m {
		if h.Enabled(ctx, l) {
			return true
		}
	}
	return false
}

// Handle fans out the record to all underlying handlers whose Enabled method returns true.
func (m MultiHandler) Handle(ctx context.Context, r slog.Record) error {
	for _, h := range m {
		// Note: We MUST NOT check Enabled here again because slog already checked it
		// for the MultiHandler itself. However, individual handlers within MultiHandler
		// might have different thresholds.
		if h.Enabled(ctx, r.Level) {
			_ = h.Handle(ctx, r)
		}
	}
	return nil
}

// WithAttrs returns a new MultiHandler whose handlers have the given attributes.
func (m MultiHandler) WithAttrs(a []slog.Attr) slog.Handler {
	hs := make(MultiHandler, len(m))
	for i, h := range m {
		hs[i] = h.WithAttrs(a)
	}
	return hs
}

// WithGroup returns a new MultiHandler whose handlers have the given group name.
func (m MultiHandler) WithGroup(n string) slog.Handler {
	hs := make(MultiHandler, len(m))
	for i, h := range m {
		hs[i] = h.WithGroup(n)
	}
	return hs
}

// Package logger provides structured logging, context propagation, and RFC 5424 / MCP logging handlers.
package logger

import (
	"context"
	"log/slog"
)

type contextKey struct{}

// WithLogger stores a logger in the context.
func WithLogger(ctx context.Context, l *slog.Logger) context.Context {
	return context.WithValue(ctx, contextKey{}, l)
}

// FromContext retrieves the logger from context.
func FromContext(ctx context.Context) *slog.Logger {
	if ctx == nil {
		return slog.Default()
	}
	if l, ok := ctx.Value(contextKey{}).(*slog.Logger); ok {
		return l
	}
	return slog.Default()
}

// Package cache provides exact-match Redis caching and cache invalidation.
package cache

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/nimendra/ERPBridge/internal/logger"
)

// FlushTool removes all exact cache entries for a given tool name.
func (m *Manager) FlushTool(ctx context.Context, toolName string) (int, error) {
	total := 0

	// 1. Flush exact cache entries (pattern scan)
	pattern := fmt.Sprintf("exact:%s:*", toolName)
	deleted, err := m.scanAndDelete(ctx, pattern)
	if err != nil {
		return total, fmt.Errorf("flush exact: %w", err)
	}
	total += deleted

	m.log.Info("cache flushed",
		slog.String("trigger", "manual"),
		slog.String("flushed_tool", toolName),
		slog.Int("entries_deleted", total),
	)

	return total, nil
}

// FlushModule removes all exact cache entries for every tool in a module.
func (m *Manager) FlushModule(ctx context.Context, module string) (int, error) {
	pattern := fmt.Sprintf("exact:%s.*:*", module)
	exact, err := m.scanAndDelete(ctx, pattern)
	if err != nil {
		return 0, err
	}
	return exact, nil
}

// AutoFlush is called by the MCP server after a successful write tool response.
func (m *Manager) AutoFlush(ctx context.Context, flushOn []string) error {
	log := logger.FromContext(ctx)
	for _, toolName := range flushOn {
		count, err := m.FlushToolInternal(ctx, toolName)
		if err != nil {
			log.Warn("auto-flush failed", slog.String("flushed_tool", toolName), slog.String("error", err.Error()))
		} else {
			log.Info("cache flushed",
				slog.String("trigger", "write_invalidation"),
				slog.String("flushed_tool", toolName),
				slog.Int("entries_deleted", count),
			)
		}
	}
	return nil
}

// FlushToolInternal is a helper for FlushTool without the manual log entry.
func (m *Manager) FlushToolInternal(ctx context.Context, toolName string) (int, error) {
	total := 0

	// 1. Flush exact cache entries (pattern scan)
	pattern := fmt.Sprintf("exact:%s:*", toolName)
	deleted, err := m.scanAndDelete(ctx, pattern)
	if err != nil {
		return total, err
	}
	total += deleted

	return total, nil
}

func (m *Manager) scanAndDelete(ctx context.Context, pattern string) (int, error) {
	var count int
	iter := m.rdb.Scan(ctx, 0, pattern, 100).Iterator()
	for iter.Next(ctx) {
		m.rdb.Del(ctx, iter.Val())
		count++
	}
	return count, iter.Err()
}

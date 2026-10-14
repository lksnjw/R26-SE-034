// Package cache provides exact-match Redis caching and cache invalidation.
package cache

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

func (m *Manager) exactGet(ctx context.Context, key string) (*Entry, error) {
	val, err := m.backend.Get(ctx, key)
	if errors.Is(err, redis.Nil) || errors.Is(err, errCacheMiss) {
		return nil, nil // clean miss
	}
	if err != nil {
		return nil, err
	}

	var envelope cacheEnvelope
	if err := json.Unmarshal(val, &envelope); err != nil || len(envelope.Response) == 0 || envelope.CachedAt.IsZero() {
		return nil, nil // legacy or corrupt entries are misses
	}
	return &Entry{
		Response: envelope.Response,
		CachedAt: envelope.CachedAt,
	}, nil
}

type cacheEnvelope struct {
	Response json.RawMessage `json:"response"`
	CachedAt time.Time       `json:"cachedAt"`
}

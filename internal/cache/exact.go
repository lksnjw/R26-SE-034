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
	val, err := m.rdb.Get(ctx, key).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil // clean miss
	}
	if err != nil {
		return nil, err
	}
	return &Entry{
		Response: json.RawMessage(val),
		CachedAt: time.Now(), // approximate
	}, nil
}

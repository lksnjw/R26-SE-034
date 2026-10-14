package cache

import (
	"context"
	"errors"
	"time"
)

var errCacheMiss = errors.New("cache miss")

// Backend is the storage seam used by the exact-match cache.
type Backend interface {
	Get(context.Context, string) ([]byte, error)
	Set(context.Context, string, []byte, time.Duration) error
	Delete(context.Context, ...string) (int, error)
	Scan(context.Context, string) ([]string, error)
	FlushAll(context.Context) (int, error)
	Stats(context.Context) (BackendStats, error)
}

// BackendStats contains cache-specific backend metrics.
type BackendStats struct {
	ExactKeys   int64
	RedisMemory string
}

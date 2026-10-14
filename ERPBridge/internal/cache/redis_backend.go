package cache

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// RedisBackend stores cache entries in Redis.
type RedisBackend struct {
	rdb *redis.Client
}

// NewRedisBackend creates a Redis-backed cache backend.
func NewRedisBackend(rdb *redis.Client) *RedisBackend {
	return &RedisBackend{rdb: rdb}
}

// Get returns a cached value or the Redis cache-miss error.
func (b *RedisBackend) Get(ctx context.Context, key string) ([]byte, error) {
	if b.rdb == nil {
		return nil, fmt.Errorf("redis client is nil")
	}
	return b.rdb.Get(ctx, key).Bytes()
}

// Set stores a value with the requested Redis TTL.
func (b *RedisBackend) Set(ctx context.Context, key string, value []byte, ttl time.Duration) error {
	if b.rdb == nil {
		return fmt.Errorf("redis client is nil")
	}
	return b.rdb.Set(ctx, key, value, ttl).Err()
}

// Delete removes keys with Redis UNLINK and returns the number removed.
func (b *RedisBackend) Delete(ctx context.Context, keys ...string) (int, error) {
	if len(keys) == 0 {
		return 0, nil
	}
	if b.rdb == nil {
		return 0, fmt.Errorf("redis client is nil")
	}
	deleted, err := b.rdb.Unlink(ctx, keys...).Result()
	return int(deleted), err
}

// Scan returns Redis keys matching the requested pattern.
func (b *RedisBackend) Scan(ctx context.Context, pattern string) ([]string, error) {
	if b.rdb == nil {
		return nil, fmt.Errorf("redis client is nil")
	}
	keys := make([]string, 0)
	iter := b.rdb.Scan(ctx, 0, pattern, 100).Iterator()
	for iter.Next(ctx) {
		keys = append(keys, iter.Val())
	}
	if err := iter.Err(); err != nil {
		return nil, err
	}
	return keys, nil
}

// FlushAll removes all exact-match cache keys.
func (b *RedisBackend) FlushAll(ctx context.Context) (int, error) {
	keys, err := b.Scan(ctx, "exact:*")
	if err != nil {
		return 0, err
	}
	return b.Delete(ctx, keys...)
}

// Stats returns exact-key count and Redis memory usage.
func (b *RedisBackend) Stats(ctx context.Context) (BackendStats, error) {
	keys, err := b.Scan(ctx, "exact:*")
	if err != nil {
		return BackendStats{}, err
	}

	info, err := b.rdb.Info(ctx, "memory").Result()
	if err != nil {
		return BackendStats{}, err
	}
	memory := ""
	for _, line := range sort.StringSlice(strings.Split(info, "\n")) {
		if after, ok := strings.CutPrefix(line, "used_memory_human:"); ok {
			memory = after
			break
		}
	}

	return BackendStats{ExactKeys: int64(len(keys)), RedisMemory: memory}, nil
}

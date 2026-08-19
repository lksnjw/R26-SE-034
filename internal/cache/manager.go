// Package cache provides exact-match Redis caching and cache invalidation.
package cache

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/nimendra/ERPBridge/internal/logger"
	"github.com/redis/go-redis/v9"
)

// Config configures caching behavior, TTL, and cache invalidation rules for a tool.
type Config struct {
	Enabled    bool     `json:"enabled"`
	TTLSeconds int      `json:"ttlSeconds"`
	IsReadOnly bool     `json:"isReadOnly"` // true = shared cache; false = role-isolated
	FlushOn    []string `json:"flushOn"`
}

// Entry represents a cached response and metadata.
type Entry struct {
	Response json.RawMessage
	CachedAt time.Time
	HitType  string // "exact" | "miss"
}

// Manager coordinates Redis exact-match caching and invalidations.
type Manager struct {
	rdb *redis.Client
	log *slog.Logger
}

// NewManager creates a new cache Manager backed by Redis.
func NewManager(rdb *redis.Client, rootLog *slog.Logger) *Manager {
	return &Manager{
		rdb: rdb,
		log: logger.Component(rootLog, "cache"),
	}
}

// EnsureIndex is a no-op since semantic caching is removed.
func (m *Manager) EnsureIndex(_ context.Context) error {
	return nil
}

// Get tries exact match.
func (m *Manager) Get(ctx context.Context, tool, role string, args map[string]any, cfg Config) (*Entry, error) {
	if !cfg.Enabled {
		return &Entry{HitType: "miss"}, nil
	}

	log := logger.FromContext(ctx)
	roleKey := roleScope(role, cfg.IsReadOnly)

	// Layer 1 — exact match
	key := exactKey(tool, roleKey, args)
	if entry, err := m.exactGet(ctx, key); err == nil && entry != nil {
		entry.HitType = "exact"
		log.Info("cache hit", slog.String("type", "exact"), slog.String("key", key))
		return entry, nil
	}

	log.Info("cache miss", slog.String("exact_key", key))
	return &Entry{HitType: "miss"}, nil
}

// Set stores a response in the exact cache.
func (m *Manager) Set(ctx context.Context, tool, role string, args map[string]any, response json.RawMessage, cfg Config) error {
	if !cfg.Enabled {
		return nil
	}

	log := logger.FromContext(ctx)
	roleKey := roleScope(role, cfg.IsReadOnly)
	ttl := time.Duration(cfg.TTLSeconds) * time.Second

	// Exact cache
	key := exactKey(tool, roleKey, args)
	if err := m.rdb.Set(ctx, key, []byte(response), ttl).Err(); err != nil {
		log.Error("redis error", slog.String("operation", "SET"), slog.String("error", err.Error()))
		return fmt.Errorf("exact cache set: %w", err)
	}
	log.Debug("cache stored", slog.String("key", key), slog.Int("ttl_seconds", cfg.TTLSeconds))

	return nil
}

// --- helpers ---

func exactKey(tool, roleKey string, args map[string]any) string {
	return fmt.Sprintf("exact:%s:%s:%s", tool, roleKey, argsHash(args))
}

func argsHash(args map[string]any) string {
	if len(args) == 0 {
		return "empty"
	}
	// Sort keys for canonical JSON before hashing
	keys := make([]string, 0, len(args))
	for k := range args {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	ordered := make([]mapEntry, 0, len(args))
	for _, k := range keys {
		ordered = append(ordered, mapEntry{Key: k, Value: args[k]})
	}
	b, _ := json.Marshal(ordered)
	h := sha256.Sum256(b)
	return fmt.Sprintf("%x", h[:4]) // 8 hex chars
}

type mapEntry struct {
	Key   string `json:"k"`
	Value any    `json:"v"`
}

func roleScope(role string, isReadOnly bool) string {
	if isReadOnly {
		return "shared"
	}
	if role == "" {
		return "anonymous"
	}
	return role
}

// Stats holds metrics on total cached exact keys and Redis memory usage.
type Stats struct {
	ExactKeys   int64  `json:"exactKeys"`
	RedisMemory string `json:"redisMemory"`
}

// Stats returns current exact key count and used memory from Redis.
func (m *Manager) Stats(ctx context.Context) (Stats, error) {
	exact, _ := m.rdb.Do(ctx, "DBSIZE").Int64()

	info, _ := m.rdb.Info(ctx, "memory").Result()
	var memory string
	for _, line := range sort.StringSlice(strings.Split(info, "\n")) {
		if strings.HasPrefix(line, "used_memory_human:") {
			memory = strings.TrimPrefix(line, "used_memory_human:")
			break
		}
	}

	return Stats{
		ExactKeys:   exact,
		RedisMemory: memory,
	}, nil
}

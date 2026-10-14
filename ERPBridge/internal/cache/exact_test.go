package cache

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/nmdra/ERPBridge/internal/logger"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestManager_ExactGet(t *testing.T) {
	s, err := miniredis.Run()
	require.NoError(t, err)
	defer s.Close()

	rdb := redis.NewClient(&redis.Options{
		Addr: s.Addr(),
	})
	log := logger.Init()
	m := NewManager(rdb, log)

	ctx := context.Background()

	t.Run("miss", func(t *testing.T) {
		entry, err := m.exactGet(ctx, "non-existent")
		assert.NoError(t, err)
		assert.Nil(t, entry)
	})

	t.Run("hit", func(t *testing.T) {
		err := s.Set("exact:test-tool:admin:123", `{"response":{"status":"ok"},"cachedAt":"2026-08-22T00:00:00Z"}`)
		require.NoError(t, err)

		entry, err := m.exactGet(ctx, "exact:test-tool:admin:123")
		assert.NoError(t, err)
		require.NotNil(t, entry)
		assert.Equal(t, json.RawMessage(`{"status":"ok"}`), entry.Response)
		assert.Equal(t, "2026-08-22T00:00:00Z", entry.CachedAt.Format(time.RFC3339))
	})

	t.Run("legacy raw entry is a miss", func(t *testing.T) {
		err := s.Set("exact:test-tool:admin:legacy", `{"status":"ok"}`)
		require.NoError(t, err)

		entry, err := m.exactGet(ctx, "exact:test-tool:admin:legacy")
		assert.NoError(t, err)
		assert.Nil(t, entry)
	})

	t.Run("redis error", func(t *testing.T) {
		// Close redis to force an error
		s.Close()

		_, err := m.exactGet(ctx, "some-key")
		assert.Error(t, err)
	})
}

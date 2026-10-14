package cache

import (
	"context"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/nmdra/ERPBridge/internal/logger"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupManager(t *testing.T) (*miniredis.Miniredis, *Manager) {
	s, err := miniredis.Run()
	require.NoError(t, err)

	rdb := redis.NewClient(&redis.Options{
		Addr: s.Addr(),
	})
	log := logger.Init()
	m := NewManager(rdb, log)

	return s, m
}

func TestManager_FlushTool(t *testing.T) {
	s, m := setupManager(t)
	defer s.Close()

	ctx := context.Background()

	// Seed data
	require.NoError(t, s.Set("exact:toolA:shared:1", "data"))
	require.NoError(t, s.Set("exact:toolA:shared:2", "data"))
	require.NoError(t, s.Set("exact:toolB:shared:1", "data"))

	t.Run("success", func(t *testing.T) {
		deleted, err := m.FlushTool(ctx, "toolA")
		assert.NoError(t, err)
		assert.Equal(t, 2, deleted)

		// Verify deletion
		assert.False(t, s.Exists("exact:toolA:shared:1"))
		assert.False(t, s.Exists("exact:toolA:shared:2"))
		assert.True(t, s.Exists("exact:toolB:shared:1"))
	})

	t.Run("redis error", func(t *testing.T) {
		s.Close()
		_, err := m.FlushTool(ctx, "toolB")
		assert.Error(t, err)
	})
}

func TestManager_FlushModule(t *testing.T) {
	s, m := setupManager(t)
	defer s.Close()

	ctx := context.Background()

	// Seed data
	require.NoError(t, s.Set("exact:moduleX.tool1:shared:1", "data"))
	require.NoError(t, s.Set("exact:moduleX.tool2:shared:1", "data"))
	require.NoError(t, s.Set("exact:moduleY.tool1:shared:1", "data"))

	t.Run("success", func(t *testing.T) {
		deleted, err := m.FlushModule(ctx, "moduleX")
		assert.NoError(t, err)
		assert.Equal(t, 2, deleted)

		// Verify deletion
		assert.False(t, s.Exists("exact:moduleX.tool1:shared:1"))
		assert.False(t, s.Exists("exact:moduleX.tool2:shared:1"))
		assert.True(t, s.Exists("exact:moduleY.tool1:shared:1"))
	})

	t.Run("redis error", func(t *testing.T) {
		s.Close()
		_, err := m.FlushModule(ctx, "moduleY")
		assert.Error(t, err)
	})
}

func TestManager_AutoFlush(t *testing.T) {
	s, m := setupManager(t)
	defer s.Close()

	ctx := logger.WithLogger(context.Background(), logger.Init())

	// Seed data
	require.NoError(t, s.Set("exact:toolA:shared:1", "data"))
	require.NoError(t, s.Set("exact:toolB:shared:1", "data"))
	require.NoError(t, s.Set("exact:toolC:shared:1", "data"))

	t.Run("success", func(t *testing.T) {
		err := m.AutoFlush(ctx, []string{"toolA", "toolB"})
		assert.NoError(t, err)

		assert.False(t, s.Exists("exact:toolA:shared:1"))
		assert.False(t, s.Exists("exact:toolB:shared:1"))
		assert.True(t, s.Exists("exact:toolC:shared:1"))
	})

	t.Run("with error on one tool", func(t *testing.T) {
		// Close server to force error
		s.Close()
		// AutoFlush logs error but returns nil
		err := m.AutoFlush(ctx, []string{"toolC"})
		assert.NoError(t, err)
	})
}

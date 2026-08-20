package mcp

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStore(t *testing.T) {
	tempDir := t.TempDir()
	dbPath := filepath.Join(tempDir, "test.db")

	store, err := NewStore(dbPath)
	require.NoError(t, err)
	defer func() { _ = store.Close() }()

	tool1 := &Tool{
		Metadata: Metadata{
			Name:     testTool1,
			Version:  testVersion100,
			Module:   "mod1",
			IsActive: true,
		},
	}

	tool2 := &Tool{
		Metadata: Metadata{
			Name:     testTool1,
			Version:  testVersion110,
			Module:   "mod1",
			IsActive: true,
		},
	}

	t.Run("Save", func(t *testing.T) {
		err := store.Save(tool1)
		require.NoError(t, err)

		err = store.Save(tool2)
		require.NoError(t, err)

		// Save again to test conflict update
		tool1.Metadata.Module = "mod1-updated"
		err = store.Save(tool1)
		require.NoError(t, err)
	})

	t.Run("Get", func(t *testing.T) {
		res, err := store.Get(testTool1, testVersion100)
		require.NoError(t, err)
		assert.Equal(t, testTool1, res.Metadata.Name)
		assert.Equal(t, "mod1-updated", res.Metadata.Module)

		// Not found
		_, err = store.Get(testTool1, "9.9.9")
		assert.Error(t, err)
	})

	t.Run("List", func(t *testing.T) {
		tools, err := store.List()
		require.NoError(t, err)
		assert.Len(t, tools, 2)
		// Should be ordered by name, version DESC
		assert.Equal(t, testVersion110, tools[0].Metadata.Version)
		assert.Equal(t, testVersion100, tools[1].Metadata.Version)
	})

	t.Run("GetStateHash", func(t *testing.T) {
		hash, err := store.GetStateHash()
		require.NoError(t, err)
		assert.Contains(t, hash, "2-") // Count is 2
	})

	t.Run("Delete", func(t *testing.T) {
		err := store.Delete(testTool1, testVersion100)
		require.NoError(t, err)

		tools, err := store.List()
		require.NoError(t, err)
		assert.Len(t, tools, 2) // Remains in DB (soft-delete)

		res, err := store.Get(testTool1, testVersion100)
		require.NoError(t, err)
		assert.False(t, res.Metadata.IsActive)

		hash, err := store.GetStateHash()
		require.NoError(t, err)
		assert.Contains(t, hash, "2-") // Count remains 2
	})

	t.Run("HardDelete", func(t *testing.T) {
		err := store.HardDelete(testTool1, testVersion100)
		require.NoError(t, err)

		tools, err := store.List()
		require.NoError(t, err)
		assert.Len(t, tools, 1) // Physically removed

		_, err = store.Get(testTool1, testVersion100)
		assert.Error(t, err) // Not found
		hash, err := store.GetStateHash()
		require.NoError(t, err)
		assert.Contains(t, hash, "1-") // Count is now 1
	})
}

func TestStore_NewStore_Errors(t *testing.T) {
	// Invalid path (directory instead of file)
	tempDir := t.TempDir()

	// Create a read-only directory to force an error on MkdirAll
	readOnlyDir := filepath.Join(tempDir, "readonly")
	err := os.MkdirAll(readOnlyDir, 0500)
	require.NoError(t, err)

	dbPath := filepath.Join(readOnlyDir, "subdir", "test.db")
	_, err = NewStore(dbPath)
	assert.Error(t, err)
}

func TestStore_GetStateHash_Empty(t *testing.T) {
	tempDir := t.TempDir()
	dbPath := filepath.Join(tempDir, "empty.db")

	store, err := NewStore(dbPath)
	require.NoError(t, err)
	defer func() { _ = store.Close() }()

	hash, err := store.GetStateHash()
	require.NoError(t, err)
	assert.Equal(t, "0-0-", hash) // 0 rows, 0 sum, empty max(updated_at)
}

func TestStore_DBClosed(t *testing.T) {
	tempDir := t.TempDir()
	store, err := NewStore(filepath.Join(tempDir, "test.db"))
	require.NoError(t, err)

	_ = store.Close()

	err = store.Save(&Tool{Metadata: Metadata{Name: "t", Version: "1"}})
	assert.Error(t, err)

	_, err = store.List()
	assert.Error(t, err)

	_, err = store.GetStateHash()
	assert.Error(t, err)

	_, err = store.Get("t", "1")
	assert.Error(t, err)

	err = store.Delete("t", "1")
	assert.Error(t, err)
}

func TestStore_Save_MarshalError(t *testing.T) {
	tempDir := t.TempDir()
	store, err := NewStore(filepath.Join(tempDir, "test.db"))
	require.NoError(t, err)
	defer func() { _ = store.Close() }()

	ch := make(chan int)
	var outputSchema any = ch
	tool := &Tool{
		Metadata: Metadata{Name: "t", Version: "1"},
		Spec: ToolSpec{
			OutputSchema: &outputSchema,
		},
	}
	err = store.Save(tool)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "marshal tool")
}

func TestStore_UnmarshalError(t *testing.T) {
	tempDir := t.TempDir()
	store, err := NewStore(filepath.Join(tempDir, "test.db"))
	require.NoError(t, err)
	defer func() { _ = store.Close() }()

	_, err = store.db.Exec(`INSERT INTO tools (name, version, data) VALUES ('bad', '1', 'not-json')`)
	require.NoError(t, err)

	_, err = store.Get("bad", "1")
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "unmarshal tool")

	_, err = store.List()
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "unmarshal tool")
}

func TestStore_List_ScanError(t *testing.T) {
	tempDir := t.TempDir()
	store, err := NewStore(filepath.Join(tempDir, "test.db"))
	require.NoError(t, err)
	defer func() { _ = store.Close() }()

	_, err = store.db.Exec(`INSERT INTO tools (name, version, data) VALUES ('null', '1', NULL)`)
	require.NoError(t, err)

	_, err = store.List()
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "scan tool")
}

func TestStore_NewStore_InitError(t *testing.T) {
	tempDir := t.TempDir()
	// dbPath is a directory, not a file path, so sqlite will fail to open or exec
	_, err := NewStore(tempDir)
	assert.Error(t, err)
}

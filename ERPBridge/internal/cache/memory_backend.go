package cache

import (
	"container/list"
	"context"
	"path"
	"sync"
	"time"
)

type memoryEntry struct {
	key       string
	value     []byte
	expiresAt time.Time
}

// MemoryBackend is a mutex-protected bounded LRU cache.
type MemoryBackend struct {
	mu         sync.Mutex
	maxEntries int
	items      map[string]*list.Element
	lru        *list.List
	now        func() time.Time
}

// NewMemoryBackend creates an in-memory backend. A non-positive capacity
// disables storage while preserving the backend and statistics interfaces.
func NewMemoryBackend(maxEntries int) *MemoryBackend {
	return &MemoryBackend{
		maxEntries: maxEntries,
		items:      make(map[string]*list.Element),
		lru:        list.New(),
		now:        time.Now,
	}
}

// Get returns a cached value or errCacheMiss when the key is absent or expired.
func (b *MemoryBackend) Get(_ context.Context, key string) ([]byte, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	element, ok := b.items[key]
	if !ok {
		return nil, errCacheMiss
	}
	entry := element.Value.(memoryEntry)
	if !entry.expiresAt.IsZero() && !b.now().Before(entry.expiresAt) {
		b.remove(element)
		return nil, errCacheMiss
	}
	b.lru.MoveToFront(element)
	return append([]byte(nil), entry.value...), nil
}

// Set stores a value and applies the requested TTL.
func (b *MemoryBackend) Set(_ context.Context, key string, value []byte, ttl time.Duration) error {
	b.mu.Lock()
	defer b.mu.Unlock()

	if b.maxEntries <= 0 {
		return nil
	}
	expiresAt := time.Time{}
	if ttl > 0 {
		expiresAt = b.now().Add(ttl)
	}
	entry := memoryEntry{key: key, value: append([]byte(nil), value...), expiresAt: expiresAt}
	if element, ok := b.items[key]; ok {
		element.Value = entry
		b.lru.MoveToFront(element)
		return nil
	}

	element := b.lru.PushFront(entry)
	b.items[key] = element
	for len(b.items) > b.maxEntries {
		b.remove(b.lru.Back())
	}
	return nil
}

// Delete removes the requested keys and returns the number removed.
func (b *MemoryBackend) Delete(_ context.Context, keys ...string) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	count := 0
	for _, key := range keys {
		if element, ok := b.items[key]; ok {
			b.remove(element)
			count++
		}
	}
	return count, nil
}

// Scan returns unexpired keys matching a path-style pattern.
func (b *MemoryBackend) Scan(_ context.Context, pattern string) ([]string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	keys := make([]string, 0, len(b.items))
	for key, element := range b.items {
		entry := element.Value.(memoryEntry)
		if !entry.expiresAt.IsZero() && !b.now().Before(entry.expiresAt) {
			b.remove(element)
			continue
		}
		matched, err := path.Match(pattern, key)
		if err != nil {
			return nil, err
		}
		if matched {
			keys = append(keys, key)
		}
	}
	return keys, nil
}

// FlushAll removes all cached entries.
func (b *MemoryBackend) FlushAll(_ context.Context) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	count := len(b.items)
	b.items = make(map[string]*list.Element)
	b.lru.Init()
	return count, nil
}

// Stats returns the number of unexpired cached entries.
func (b *MemoryBackend) Stats(_ context.Context) (BackendStats, error) {
	b.mu.Lock()
	defer b.mu.Unlock()

	for _, element := range b.lruBackToFront() {
		entry := element.Value.(memoryEntry)
		if !entry.expiresAt.IsZero() && !b.now().Before(entry.expiresAt) {
			b.remove(element)
		}
	}
	return BackendStats{ExactKeys: int64(len(b.items))}, nil
}

func (b *MemoryBackend) remove(element *list.Element) {
	if element == nil {
		return
	}
	entry := element.Value.(memoryEntry)
	delete(b.items, entry.key)
	b.lru.Remove(element)
}

func (b *MemoryBackend) lruBackToFront() []*list.Element {
	result := make([]*list.Element, 0, b.lru.Len())
	for element := b.lru.Back(); element != nil; element = element.Prev() {
		result = append(result, element)
	}
	return result
}

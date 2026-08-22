// Package idp provides API registration and OpenAPI-to-MCP tool schema generation.
package idp

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/nmdra/ERPBridge/internal/logger"
)

// API represents a registered downstream ERP API endpoint and authentication metadata.
type API struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	URL          string    `json:"url"`
	Method       string    `json:"method"`
	AuthType     string    `json:"authType"`
	AuthHeader   string    `json:"authHeader,omitempty"`
	AuthKey      string    `json:"authKey,omitempty"`
	AuthUsername string    `json:"authUsername,omitempty"`
	AuthToken    string    `json:"authToken,omitempty"`
	Module       string    `json:"module"`
	Description  string    `json:"description"`
	Status       string    `json:"status"`
	CreatedAt    time.Time `json:"createdAt"`
}

// Registry manages storage and retrieval of registered API definitions.
type Registry struct {
	path string
	log  *slog.Logger
	mu   sync.RWMutex
	APIs map[string]API `json:"apis"`
}

// NewRegistry initializes an API registry from the specified file path or default user home path.
func NewRegistry(path string, rootLog *slog.Logger) (*Registry, error) {
	if path == "" {
		home, _ := os.UserHomeDir()
		path = filepath.Join(home, ".bridgectl", "registry.json")
	}

	reg := &Registry{
		path: path,
		log:  logger.Component(rootLog, "idp"),
		APIs: make(map[string]API),
	}

	if err := reg.load(); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("load registry: %w", err)
	}

	return reg, nil
}

func (r *Registry) load() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.loadLocked()
}

func (r *Registry) loadLocked() error {
	data, err := os.ReadFile(r.path)
	if err != nil {
		return err
	}
	var persisted struct {
		APIs map[string]API `json:"apis"`
	}
	if err := json.Unmarshal(data, &persisted); err != nil {
		return err
	}
	if persisted.APIs == nil {
		persisted.APIs = make(map[string]API)
	}
	r.APIs = persisted.APIs
	return nil
}

func (r *Registry) save() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	lock, err := acquireRegistryLock(r.path + ".lock")
	if err != nil {
		return err
	}
	defer lock.release()
	return r.saveLocked()
}

func (r *Registry) saveLocked() error {
	dir := filepath.Dir(r.path)
	if err := os.MkdirAll(dir, 0750); err != nil {
		return err
	}
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	temp, err := os.CreateTemp(dir, ".registry-*.tmp")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer func() { _ = os.Remove(tempPath) }()
	if err := temp.Chmod(0600); err != nil {
		_ = temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempPath, r.path)
}

func (r *Registry) withWrite(fn func() error) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	dir := filepath.Dir(r.path)
	if err := os.MkdirAll(dir, 0750); err != nil {
		return err
	}
	lock, err := acquireRegistryLock(r.path + ".lock")
	if err != nil {
		return err
	}
	defer lock.release()

	if err := r.loadLocked(); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("reload registry: %w", err)
	}
	if r.APIs == nil {
		r.APIs = make(map[string]API)
	}
	if err := fn(); err != nil {
		return err
	}
	return r.saveLocked()
}

type registryFileLock struct {
	path string
	file *os.File
}

func acquireRegistryLock(path string) (*registryFileLock, error) {
	deadline := time.Now().Add(5 * time.Second)
	for {
		// #nosec G304 -- the lock path is derived from the caller-selected registry path.
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err == nil {
			return &registryFileLock{path: path, file: file}, nil
		}
		if !os.IsExist(err) {
			return nil, fmt.Errorf("acquire registry lock: %w", err)
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("acquire registry lock: timed out")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (l *registryFileLock) release() {
	_ = l.file.Close()
	_ = os.Remove(l.path)
}

// Register adds or updates an API definition in the registry.
func (r *Registry) Register(api *API) error {
	return r.withWrite(func() error {
		if api.ID == "" {
			api.ID = fmt.Sprintf("api-%d", time.Now().UnixNano())
		}
		api.CreatedAt = time.Now()
		api.Status = "active"
		r.APIs[api.Name] = *api

		r.log.Info("API registered",
			slog.String("name", api.Name),
			slog.String("module", api.Module),
			slog.String("url", api.URL),
		)
		return nil
	})
}

// List returns a slice of all registered APIs.
func (r *Registry) List() []API {
	r.mu.RLock()
	defer r.mu.RUnlock()
	list := make([]API, 0, len(r.APIs))
	for _, api := range r.APIs {
		list = append(list, api)
	}
	return list
}

// Delete removes an API definition by name.
func (r *Registry) Delete(name string) error {
	return r.withWrite(func() error {
		delete(r.APIs, name)
		return nil
	})
}

// Get returns the API definition by name if found.
func (r *Registry) Get(name string) (API, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	api, ok := r.APIs[name]
	return api, ok
}

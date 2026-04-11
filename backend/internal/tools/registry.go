package tools

import (
	"fmt"
	"sync"
)

type Registry struct {
	mu       sync.RWMutex
	tools    map[string]Tool
	fallback Tool
}

func NewRegistry(fallback Tool) *Registry {
	return &Registry{
		tools:    map[string]Tool{},
		fallback: fallback,
	}
}

func (r *Registry) Register(tool Tool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.tools[tool.Name()] = tool
}

func (r *Registry) Get(name string) (Tool, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	if tool, ok := r.tools[name]; ok {
		return tool, nil
	}
	if r.fallback != nil {
		return r.fallback, nil
	}

	return nil, fmt.Errorf("tool %q is not registered", name)
}

func (r *Registry) Names() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	names := make([]string, 0, len(r.tools))
	for name := range r.tools {
		names = append(names, name)
	}
	return names
}

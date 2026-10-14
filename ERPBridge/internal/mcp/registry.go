package mcp

import (
	"fmt"
	"sort"
	"strings"

	"github.com/Masterminds/semver/v3"
)

// ToolRegistry manages multiple versions of tools and resolves them for the LLM.
type ToolRegistry struct {
	tools map[string]map[string]*Tool // name -> version -> Tool
}

// NewToolRegistry creates a new instance of ToolRegistry.
func NewToolRegistry() *ToolRegistry {
	return &ToolRegistry{
		tools: make(map[string]map[string]*Tool),
	}
}

// Add adds a tool to the registry.
func (r *ToolRegistry) Add(t *Tool) error {
	name := t.Metadata.Name
	version := t.Metadata.Version

	if _, err := semver.NewVersion(version); err != nil {
		return fmt.Errorf("invalid semver version %s for tool %s: %w", version, name, err)
	}

	if _, ok := r.tools[name]; !ok {
		r.tools[name] = make(map[string]*Tool)
	}

	r.tools[name][version] = t
	return nil
}

// Resolve finds the appropriate version of a tool based on an optional version constraint.
// If no version is specified, it returns the latest stable version.
// It only returns tools that are active.
func (r *ToolRegistry) Resolve(name string, versionConstraint string) (*Tool, error) {
	versions, ok := r.tools[name]
	if !ok {
		return nil, fmt.Errorf("tool %s not found", name)
	}

	if versionConstraint != "" {
		// If explicit version like "list_employees@1.0.0" is passed
		if t, ok := versions[versionConstraint]; ok {
			if !t.Metadata.IsActive {
				return nil, fmt.Errorf("tool %s@%s is inactive", name, versionConstraint)
			}
			return t, nil
		}

		// If it's a semver constraint like "^1.0.0"
		c, err := semver.NewConstraint(versionConstraint)
		if err != nil {
			return nil, fmt.Errorf("invalid version constraint %s: %w", versionConstraint, err)
		}

		var bestVersion *semver.Version
		var bestTool *Tool

		for vStr, t := range versions {
			if !t.Metadata.IsActive {
				continue
			}
			v, _ := semver.NewVersion(vStr)
			if c.Check(v) {
				if bestVersion == nil || v.GreaterThan(bestVersion) {
					bestVersion = v
					bestTool = t
				}
			}
		}

		if bestTool != nil {
			return bestTool, nil
		}
		return nil, fmt.Errorf("no active version of tool %s matches constraint %s", name, versionConstraint)
	}

	// Default: Latest stable version (no pre-releases, highest version)
	var latestStable *semver.Version
	var latestTool *Tool

	for vStr, t := range versions {
		if !t.Metadata.IsActive {
			continue
		}
		v, _ := semver.NewVersion(vStr)
		if v.Prerelease() == "" {
			if latestStable == nil || v.GreaterThan(latestStable) {
				latestStable = v
				latestTool = t
			}
		}
	}

	if latestTool != nil {
		return latestTool, nil
	}

	// If no stable versions, return the absolute latest active
	var absoluteLatest *semver.Version
	var absoluteTool *Tool

	for vStr, t := range versions {
		if !t.Metadata.IsActive {
			continue
		}
		v, _ := semver.NewVersion(vStr)
		if absoluteLatest == nil || v.GreaterThan(absoluteLatest) {
			absoluteLatest = v
			absoluteTool = t
		}
	}

	if absoluteTool != nil {
		return absoluteTool, nil
	}

	return nil, fmt.Errorf("no active version found for tool %s", name)
}

// ListStable returns the latest stable version of all active tools.
func (r *ToolRegistry) ListStable() []*Tool {
	var result []*Tool
	for name := range r.tools {
		if t, err := r.Resolve(name, ""); err == nil {
			result = append(result, t)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].Metadata.Name < result[j].Metadata.Name
	})
	return result
}

// Remove deactivates a specific version of a tool in the registry instead of removing it.
func (r *ToolRegistry) Remove(name, version string) {
	if versions, ok := r.tools[name]; ok {
		if t, ok := versions[version]; ok {
			t.Metadata.IsActive = false
		}
	}
}

// ListAll returns all versions of all tools (including inactive ones).
func (r *ToolRegistry) ListAll() []*Tool {
	var result []*Tool
	for _, versions := range r.tools {
		for _, t := range versions {
			result = append(result, t)
		}
	}
	return result
}

// ListActive returns all active versions of all tools.
func (r *ToolRegistry) ListActive() []*Tool {
	var result []*Tool
	for _, versions := range r.tools {
		for _, t := range versions {
			if t.Metadata.IsActive {
				result = append(result, t)
			}
		}
	}
	return result
}

// ParseToolIdentifier splits "name@version" into "name" and "version".
func ParseToolIdentifier(id string) (name, version string) {
	parts := strings.SplitN(id, "@", 2)
	if len(parts) == 2 {
		return parts[0], parts[1]
	}
	return parts[0], ""
}

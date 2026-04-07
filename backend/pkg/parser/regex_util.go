package parser

import (
	"fmt"
	"regexp"
	"strings"
)

var variablePattern = regexp.MustCompile(`\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}`)

func ResolveVariables(value interface{}, state map[string]interface{}) interface{} {
	switch typed := value.(type) {
	case string:
		return resolveString(typed, state)
	case []interface{}:
		out := make([]interface{}, 0, len(typed))
		for _, item := range typed {
			out = append(out, ResolveVariables(item, state))
		}
		return out
	case map[string]interface{}:
		out := make(map[string]interface{}, len(typed))
		for key, item := range typed {
			out[key] = ResolveVariables(item, state)
		}
		return out
	default:
		return value
	}
}

func resolveString(value string, state map[string]interface{}) string {
	return variablePattern.ReplaceAllStringFunc(value, func(match string) string {
		key := strings.TrimSpace(strings.TrimSuffix(strings.TrimPrefix(match, "{{"), "}}"))
		if resolved, ok := lookupPath(state, key); ok {
			return fmt.Sprint(resolved)
		}
		return match
	})
}

func lookupPath(state map[string]interface{}, path string) (interface{}, bool) {
	parts := strings.Split(path, ".")
	var current interface{} = state

	for _, part := range parts {
		asMap, ok := current.(map[string]interface{})
		if !ok {
			return nil, false
		}
		current, ok = asMap[part]
		if !ok {
			return nil, false
		}
	}

	return current, true
}

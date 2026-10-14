package parser

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"gopkg.in/yaml.v3"
)

func ParseWorkflowYAML(raw string) (models.WorkflowBlueprint, error) {
	var blueprint models.WorkflowBlueprint
	clean := StripMarkdownFence(raw)
	if err := yaml.Unmarshal([]byte(clean), &blueprint); err != nil {
		return blueprint, fmt.Errorf("parse workflow yaml: %w", err)
	}

	return blueprint, nil
}

func StringifyWorkflowYAML(blueprint models.WorkflowBlueprint) (string, error) {
	out, err := yaml.Marshal(blueprint)
	if err != nil {
		return "", fmt.Errorf("stringify workflow yaml: %w", err)
	}

	return string(out), nil
}

func StripMarkdownFence(raw string) string {
	clean := strings.TrimSpace(raw)
	clean = strings.TrimPrefix(clean, "```yaml")
	clean = strings.TrimPrefix(clean, "```yml")
	clean = strings.TrimPrefix(clean, "```")
	clean = strings.TrimSuffix(clean, "```")
	return strings.TrimSpace(clean)
}

func Checksum(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return "sha256:" + hex.EncodeToString(sum[:])[:16]
}

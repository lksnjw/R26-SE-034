package healing

import (
	"context"
	"fmt"
	"time"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/synthesizer"
)

type Healer struct {
	Synthesizer *synthesizer.Service
	MaxAttempts int
}

func NewHealer(service *synthesizer.Service) *Healer {
	return &Healer{Synthesizer: service, MaxAttempts: 1}
}

func (h *Healer) Repair(ctx context.Context, originalPrompt, failingYAML string, executionErr error) (string, map[string]interface{}, error) {
	if h.MaxAttempts <= 0 {
		return "", nil, executionErr
	}

	prompt := fmt.Sprintf(`Repair this workflow YAML after an MCP execution failure.

Original user request:
%s

Failing YAML:
%s

Execution error:
%s

Return corrected YAML only.`, originalPrompt, failingYAML, executionErr.Error())

	result, err := h.Synthesizer.Synthesize(ctx, prompt, "strict-yaml", "", map[string]interface{}{"repair": true})
	if err != nil {
		return "", nil, err
	}

	event := map[string]interface{}{
		"id":          "heal_" + time.Now().UTC().Format("20060102150405"),
		"type":        "llm_yaml_repair",
		"status":      "generated",
		"startedAt":   time.Now().UTC(),
		"completedAt": time.Now().UTC(),
	}

	return result.YAML, event, nil
}

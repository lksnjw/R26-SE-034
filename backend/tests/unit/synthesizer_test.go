package unit

import (
	"context"
	"testing"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/synthesizer"
)

func TestSynthesizerFallbackReturnsYAML(t *testing.T) {
	service := synthesizer.NewService("http://localhost:11434", "phi3:mini", false)
	result, err := service.Synthesize(context.Background(), "approve employee leave", "balanced", "", nil)
	if err != nil {
		t.Fatalf("expected fallback synthesis, got error: %v", err)
	}
	if result.YAML == "" {
		t.Fatal("expected generated YAML")
	}
}

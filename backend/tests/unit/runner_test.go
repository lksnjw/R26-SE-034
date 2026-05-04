package unit

import (
	"context"
	"testing"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/runner"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/tools"
	"go.uber.org/zap"
)

func TestRunnerExecutesRegisteredTool(t *testing.T) {
	mcp := tools.NewMCPClient("", 0)
	registry := tools.NewRegistry(tools.GenericMCPTool{Action: "policy_check", Client: mcp})
	exec := runner.NewExecutor(registry, zap.NewNop())
	blueprint := models.WorkflowBlueprint{
		Name:    "test",
		Trigger: models.BlueprintTrigger{Type: "user.requested"},
		Steps:   []models.WorkflowStepBlueprint{{ID: "policy", Action: "policy_check"}},
	}
	workflow := models.Workflow{ID: "wf-test", Name: "Test"}
	result, err := exec.Run(context.Background(), "run-test", workflow, blueprint, map[string]interface{}{})
	if err != nil {
		t.Fatalf("runner failed: %v", err)
	}
	if len(result.Logs) != 1 {
		t.Fatalf("expected one log, got %d", len(result.Logs))
	}
}

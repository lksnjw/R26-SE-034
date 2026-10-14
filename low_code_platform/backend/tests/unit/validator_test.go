package unit

import (
	"testing"

	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
)

func TestValidatorAcceptsSafeWorkflow(t *testing.T) {
	validator := workflowvalidator.NewWorkflowValidator()
	result, _ := validator.ValidateYAML("name: safe\ntrigger:\n  type: user.requested\nsteps:\n  - id: policy\n    action: policy_check\n", []string{"workflow:run"})
	if !result.Valid {
		t.Fatalf("expected workflow to be valid: %+v", result)
	}
}

func TestValidatorBlocksDirectDatabaseAccess(t *testing.T) {
	validator := workflowvalidator.NewWorkflowValidator()
	result, _ := validator.ValidateYAML("name: unsafe\ntrigger:\n  type: user.requested\nsteps:\n  - id: direct\n    action: drop_database\n", []string{"workflow:run"})
	if result.Valid {
		t.Fatal("expected semantic gate to block direct database action")
	}
}

package validator

import (
	"fmt"

	playground "github.com/go-playground/validator/v10"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/pkg/parser"
)

type WorkflowValidator struct {
	validate *playground.Validate
}

func NewWorkflowValidator() *WorkflowValidator {
	return &WorkflowValidator{validate: playground.New()}
}

func (v *WorkflowValidator) ValidateYAML(raw string, permissions []string) (models.ValidationResult, models.WorkflowBlueprint) {
	blueprint, err := parser.ParseWorkflowYAML(raw)
	if err != nil {
		return models.ValidationResult{
			Valid:    false,
			Score:    0,
			Errors:   []models.ValidationIssue{{Code: "YAML_PARSE_ERROR", Message: err.Error()}},
			Warnings: []models.ValidationIssue{},
			Checks:   []models.ValidationCheck{{Name: "Schema valid", Passed: false}},
		}, blueprint
	}

	if err := v.validate.Struct(blueprint); err != nil {
		return models.ValidationResult{
			Valid:    false,
			Score:    0.3,
			Errors:   []models.ValidationIssue{{Code: "SCHEMA_INVALID", Message: fmt.Sprintf("YAML failed schema validation: %v", err)}},
			Warnings: []models.ValidationIssue{},
			Checks:   []models.ValidationCheck{{Name: "Schema valid", Passed: false}},
		}, blueprint
	}

	semantic := v.ValidateSemantics(blueprint, permissions)
	if !semantic.Valid {
		return semantic, blueprint
	}

	return models.ValidationResult{
		Valid:    true,
		Score:    semantic.Score,
		Errors:   []models.ValidationIssue{},
		Warnings: semantic.Warnings,
		Checks: []models.ValidationCheck{
			{Name: "Schema valid", Passed: true},
			{Name: "RBAC policy attached", Passed: true},
			{Name: "Retry budget configured", Passed: hasRetryBudget(blueprint)},
		},
	}, blueprint
}

func hasRetryBudget(blueprint models.WorkflowBlueprint) bool {
	for _, step := range blueprint.Steps {
		if step.RetryCount > 0 {
			return true
		}
	}
	return false
}

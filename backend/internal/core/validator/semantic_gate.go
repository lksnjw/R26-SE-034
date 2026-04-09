package validator

import (
	"strings"

	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

var writeActions = map[string]bool{
	"create_leave":   true,
	"create_invoice": true,
	"send_webhook":   true,
	"notify_finance": true,
}

func (v *WorkflowValidator) ValidateSemantics(blueprint models.WorkflowBlueprint, permissions []string) models.ValidationResult {
	hasRunPermission := contains(permissions, "workflow:run") || len(permissions) == 0
	warnings := []models.ValidationIssue{}

	for _, step := range blueprint.Steps {
		action := strings.ToLower(step.Action)
		if strings.Contains(action, "sql") || strings.Contains(action, "database") || strings.Contains(action, "drop_") {
			return models.ValidationResult{
				Valid: false,
				Score: 0.1,
				Errors: []models.ValidationIssue{{
					Code:    "DIRECT_ERP_ACCESS_BLOCKED",
					Message: "Semantic gate blocked direct database/ERP access. Use MCP bridge tools only.",
					NodeID:  step.ID,
				}},
				Warnings: warnings,
				Checks: []models.ValidationCheck{
					{Name: "Schema valid", Passed: true},
					{Name: "RBAC policy attached", Passed: false},
				},
			}
		}

		if writeActions[action] && !hasRunPermission {
			return models.ValidationResult{
				Valid: false,
				Score: 0.2,
				Errors: []models.ValidationIssue{{
					Code:    "RBAC_DENIED",
					Message: "The current user is not allowed to run write actions.",
					NodeID:  step.ID,
				}},
				Warnings: warnings,
				Checks: []models.ValidationCheck{
					{Name: "Schema valid", Passed: true},
					{Name: "RBAC policy attached", Passed: false},
				},
			}
		}

		if writeActions[action] && step.RetryCount == 0 {
			warnings = append(warnings, models.ValidationIssue{
				Code:    "RETRY_BUDGET_LOW",
				Message: "External write action should include a retry budget for self-healing.",
				NodeID:  step.ID,
			})
		}
	}

	score := 0.94
	if len(warnings) > 0 {
		score = 0.86
	}

	return models.ValidationResult{Valid: true, Score: score, Errors: []models.ValidationIssue{}, Warnings: warnings}
}

func contains(items []string, target string) bool {
	for _, item := range items {
		if item == target {
			return true
		}
	}
	return false
}

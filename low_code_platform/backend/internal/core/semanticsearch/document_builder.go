package semanticsearch

import (
	"fmt"
	"strings"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
)

func toolDocument(tool registry.Tool) string {
	parts := []string{
		tool.ToolID,
		tool.Name,
		tool.DisplayName,
		tool.Module,
		tool.Status,
		tool.Description,
		tool.BusinessCapability,
		tool.SemanticSearchDescription,
		strings.Join(tool.BPIProcessAlignment, " "),
		strings.Join(tool.RequiredParameters, " "),
		strings.Join(tool.OptionalParameters, " "),
		strings.Join(tool.SemanticSearchKeywords, " "),
		strings.Join(tool.AllowedRoles, " "),
		strings.Join(tool.CurrentGaps, " "),
	}
	return strings.Join(parts, " ")
}

func ruleDocument(rule registry.Rule) string {
	parts := []string{
		rule.RuleID,
		rule.RuleName,
		rule.RuleType,
		rule.Domain,
		rule.Description,
		strings.Join(rule.AppliesToTools, " "),
		strings.Join(rule.AppliesToRoles, " "),
		rule.ValidatorMessage,
		rule.LLMPromptInstruction,
		rule.HealingGuidance,
		rule.EnforcementAction,
		rule.Severity,
		strings.Join(rule.BPIAlignment, " "),
	}
	return strings.Join(parts, " ")
}

func templateDocument(template registry.ProcessTemplate) string {
	parts := []string{
		template.TemplateID,
		template.TemplateName,
		template.BPIAlignment,
		template.Description,
		strings.Join(template.ERPSystemsInvolved, " "),
		strings.Join(template.RequiredTools, " "),
		strings.Join(template.RequiredRules, " "),
		strings.Join(template.ValidationFocus, " "),
		strings.Join(template.SampleUserIntents, " "),
	}
	for _, step := range template.NormalFlow {
		parts = append(parts, toString(step))
	}
	for _, flow := range template.ExceptionFlows {
		parts = append(parts, toString(flow))
	}
	return strings.Join(parts, " ")
}

func exampleDocument(example registry.FewShotExample) string {
	parts := []string{
		example.ScenarioID,
		example.UserRole,
		example.UserRequest,
		example.ExpectedDomain,
		example.ExpectedIntent,
		example.ExpectedDecision,
		example.RiskLevel,
		strings.Join(example.ExpectedTools, " "),
		strings.Join(example.ExpectedRules, " "),
		strings.Join(example.BPIAlignment, " "),
		example.Notes,
	}
	return strings.Join(parts, " ")
}

func toString(value interface{}) string {
	return fmt.Sprint(value)
}

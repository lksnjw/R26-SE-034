package validator

import (
	"fmt"
	"math"
	"sort"
	"strings"

	playground "github.com/go-playground/validator/v10"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/pkg/parser"
)

type CandidateValidationResult struct {
	CandidateID      string                    `json:"candidate_id"`
	Passed           bool                      `json:"passed"`
	Score            float64                   `json:"score"`
	SchemaOK         bool                      `json:"schema_ok"`
	ToolValidityOK   bool                      `json:"tool_validity_ok"`
	ParametersOK     bool                      `json:"parameters_ok"`
	RBACOK           bool                      `json:"rbac_ok"`
	PolicyOK         bool                      `json:"policy_ok"`
	ProcessOrderOK   bool                      `json:"process_order_ok"`
	RiskOK           bool                      `json:"risk_ok"`
	Errors           []string                  `json:"errors"`
	Warnings         []string                  `json:"warnings"`
	FailedRules      []string                  `json:"failed_rules"`
	RegistryVersions registry.RegistryVersions `json:"registry_versions"`
	EstimatedRisk    string                    `json:"estimated_risk_level"`
	StepCount        int                       `json:"step_count"`
	ParsedWorkflow   *models.WorkflowBlueprint `json:"-"`
	ToolRisks        map[string]string         `json:"tool_risks,omitempty"`
	Metadata         map[string]interface{}    `json:"metadata,omitempty"`
}

type RegistryValidator struct {
	Tools    *registry.ToolRegistry
	Rules    *registry.RuleRegistry
	validate *playground.Validate
}

func NewRegistryValidator(tools *registry.ToolRegistry, rules *registry.RuleRegistry) *RegistryValidator {
	return &RegistryValidator{Tools: tools, Rules: rules, validate: playground.New()}
}

func (v *RegistryValidator) ValidateCandidate(candidateID, rawYAML, userRole string) CandidateValidationResult {
	result := CandidateValidationResult{
		CandidateID:      candidateID,
		SchemaOK:         true,
		ToolValidityOK:   true,
		ParametersOK:     true,
		RBACOK:           true,
		PolicyOK:         true,
		ProcessOrderOK:   true,
		RiskOK:           true,
		Errors:           []string{},
		Warnings:         []string{},
		FailedRules:      []string{},
		RegistryVersions: registry.RegistryVersions{Tools: v.Tools.Version(), Rules: v.Rules.Version()},
		EstimatedRisk:    "low",
		ToolRisks:        map[string]string{},
		Metadata:         map[string]interface{}{},
	}

	blueprint, err := parser.ParseWorkflowYAML(rawYAML)
	if err != nil {
		result.SchemaOK = false
		result.addError("YAML_PARSE_ERROR", err.Error())
		result.finish()
		return result
	}
	result.ParsedWorkflow = &blueprint
	result.StepCount = len(blueprint.Steps)

	if err := v.validate.Struct(blueprint); err != nil {
		result.SchemaOK = false
		result.addError("SCHEMA_INVALID", fmt.Sprintf("YAML failed schema validation: %v", err))
	}
	if strings.TrimSpace(blueprint.Description) == "" {
		result.SchemaOK = false
		result.addError("SCHEMA_DESCRIPTION_REQUIRED", "description is required for generated workflow candidates")
	}

	stepsByAction := map[string][]int{}
	usedTools := []registry.Tool{}
	for index, step := range blueprint.Steps {
		action := strings.TrimSpace(step.Action)
		stepsByAction[strings.ToLower(action)] = append(stepsByAction[strings.ToLower(action)], index)
		tool, ok := v.Tools.FindToolByName(action)
		if !ok {
			result.ToolValidityOK = false
			result.addRuleError("GLOBAL-SAFETY-001", fmt.Sprintf("Unknown or hallucinated tool %q in step %s", action, step.ID))
			continue
		}
		usedTools = append(usedTools, tool)
		result.ToolRisks[tool.Name] = tool.RiskLevel
		result.EstimatedRisk = higherRisk(result.EstimatedRisk, tool.RiskLevel)

		v.validateToolStatus(tool, step, &result)
		v.validateRequiredParameters(tool, step, &result)
		v.validateRole(tool, userRole, step, &result)
		if containsSensitiveKey(step.Parameters) {
			result.PolicyOK = false
			result.addRuleError("GLOBAL-SAFETY-002", fmt.Sprintf("Step %s contains sensitive credential-like parameter", step.ID))
		}
	}

	v.evaluateRules(blueprint, stepsByAction, usedTools, userRole, &result)
	result.finish()
	return result
}

func (v *RegistryValidator) validateToolStatus(tool registry.Tool, step models.WorkflowStepBlueprint, result *CandidateValidationResult) {
	switch strings.ToLower(strings.TrimSpace(tool.Status)) {
	case "", "active_mcp_schema_present":
		return
	case "mock_endpoint_available_schema_missing":
		result.ToolValidityOK = false
		result.addRuleError("CAP-GAP-001", fmt.Sprintf("Tool %s in step %s has mock endpoint but missing active MCP schema", tool.Name, step.ID))
	case "recommended_future_capability":
		result.ToolValidityOK = false
		result.addRuleError("CAP-GAP-001", fmt.Sprintf("Tool %s in step %s is a future capability and cannot execute directly", tool.Name, step.ID))
	default:
		result.ToolValidityOK = false
		result.addRuleError("CAP-GAP-001", fmt.Sprintf("Tool %s in step %s has unsupported status %q", tool.Name, step.ID, tool.Status))
	}
}

func (v *RegistryValidator) validateRequiredParameters(tool registry.Tool, step models.WorkflowStepBlueprint, result *CandidateValidationResult) {
	if step.Parameters == nil {
		step.Parameters = map[string]interface{}{}
	}
	for _, param := range tool.RequiredParameters {
		value, ok := step.Parameters[param]
		if !ok || isEmptyValue(value) {
			result.ParametersOK = false
			result.addError("MISSING_PARAMETER", fmt.Sprintf("Step %s using %s is missing required parameter %s", step.ID, tool.Name, param))
		}
	}
}

func (v *RegistryValidator) validateRole(tool registry.Tool, userRole string, step models.WorkflowStepBlueprint, result *CandidateValidationResult) {
	if roleIsAllowed(userRole, tool.AllowedRoles) {
		return
	}
	result.RBACOK = false
	result.addError("RBAC_DENIED", fmt.Sprintf("Role %q is not allowed to execute %s in step %s", userRole, tool.Name, step.ID))
}

func (v *RegistryValidator) evaluateRules(blueprint models.WorkflowBlueprint, stepsByAction map[string][]int, usedTools []registry.Tool, userRole string, result *CandidateValidationResult) {
	for _, rule := range v.Rules.GetEnabledRules() {
		if !ruleAppliesToCandidate(rule, usedTools, userRole, result.EstimatedRisk) {
			continue
		}
		switch rule.RuleType {
		case "rbac":
			v.evalRBACRule(rule, usedTools, userRole, result)
		case "parameter_required":
			v.evalParameterRule(rule, blueprint, result)
		case "amount_threshold", "quantity_threshold":
			v.evalThresholdRule(rule, blueprint, result)
		case "process_order":
			v.evalProcessOrderRule(rule, stepsByAction, result)
		case "separation_of_duties":
			v.evalSeparationOfDutiesRule(rule, blueprint, result)
		case "risk_escalation":
			v.evalRiskRule(rule, blueprint, usedTools, result)
		case "audit":
			v.evalAuditRule(rule, blueprint, usedTools, result)
		case "data_confidentiality", "execution_safety", "capability_gap", "cache_safety":
			// These are enforced by dedicated checks or documented for prompt grounding.
		default:
			result.Warnings = append(result.Warnings, "Unsupported governance rule type "+rule.RuleType+" for rule "+rule.RuleID)
		}
	}
}

func (v *RegistryValidator) evalRBACRule(rule registry.Rule, usedTools []registry.Tool, userRole string, result *CandidateValidationResult) {
	if len(rule.AppliesToRoles) == 0 || !roleMatchesAny(userRole, rule.AppliesToRoles) {
		return
	}
	for _, tool := range usedTools {
		if ruleAppliesToTool(rule, tool) && rule.EnforcementAction == "block" {
			result.RBACOK = false
			result.addRuleError(rule.RuleID, message(rule, fmt.Sprintf("Role %s is blocked from %s", userRole, tool.Name)))
		}
	}
}

func (v *RegistryValidator) evalParameterRule(rule registry.Rule, blueprint models.WorkflowBlueprint, result *CandidateValidationResult) {
	params := interfaceSliceToStrings(rule.Condition.Value)
	if len(params) == 0 {
		return
	}
	for _, step := range blueprint.Steps {
		tool, ok := v.Tools.FindToolByName(step.Action)
		if !ok || !ruleAppliesToTool(rule, tool) {
			continue
		}
		for _, param := range params {
			if step.Parameters == nil || isEmptyValue(step.Parameters[param]) {
				result.ParametersOK = false
				result.addRuleError(rule.RuleID, message(rule, fmt.Sprintf("Step %s missing parameter %s", step.ID, param)))
			}
		}
	}
}

func (v *RegistryValidator) evalThresholdRule(rule registry.Rule, blueprint models.WorkflowBlueprint, result *CandidateValidationResult) {
	param := rule.Condition.Parameter
	threshold, ok := numeric(rule.Condition.Value)
	if !ok || param == "" {
		return
	}
	for _, step := range blueprint.Steps {
		tool, found := v.Tools.FindToolByName(step.Action)
		if !found || !ruleAppliesToTool(rule, tool) {
			continue
		}
		value, ok := numeric(step.Parameters[param])
		if !ok || !compareNumber(value, rule.Condition.Operator, threshold) {
			continue
		}
		if rule.EnforcementAction == "require_human_approval" && !hasApprovalStep(blueprint) {
			result.PolicyOK = false
			result.RiskOK = false
			result.addRuleError(rule.RuleID, message(rule, fmt.Sprintf("Step %s has %s %.2f and requires human approval", step.ID, param, value)))
		}
	}
}

func (v *RegistryValidator) evalProcessOrderRule(rule registry.Rule, stepsByAction map[string][]int, result *CandidateValidationResult) {
	actions := interfaceSliceToStrings(rule.Condition.Value)
	if len(actions) < 2 {
		return
	}
	before := strings.ToLower(actions[0])
	after := strings.ToLower(actions[1])
	beforeIndexes := stepsByAction[before]
	afterIndexes := stepsByAction[after]
	if len(afterIndexes) == 0 {
		return
	}
	if len(beforeIndexes) == 0 || minIndex(beforeIndexes) > maxIndex(afterIndexes) {
		result.ProcessOrderOK = false
		result.addRuleError(rule.RuleID, message(rule, fmt.Sprintf("%s must occur before %s", actions[0], actions[1])))
	}
}

func (v *RegistryValidator) evalSeparationOfDutiesRule(rule registry.Rule, blueprint models.WorkflowBlueprint, result *CandidateValidationResult) {
	for _, step := range blueprint.Steps {
		requester := fmt.Sprint(step.Parameters["requester_id"])
		approver := fmt.Sprint(step.Parameters["approver_id"])
		if requester != "" && requester != "<nil>" && requester == approver {
			result.PolicyOK = false
			result.addRuleError(rule.RuleID, message(rule, "requester_id and approver_id must be different"))
		}
	}
}

func (v *RegistryValidator) evalRiskRule(rule registry.Rule, blueprint models.WorkflowBlueprint, usedTools []registry.Tool, result *CandidateValidationResult) {
	requiresApproval := false
	for _, tool := range usedTools {
		if riskRank(tool.RiskLevel) >= riskRank("high") {
			requiresApproval = true
			break
		}
	}
	if requiresApproval && !hasApprovalStep(blueprint) {
		result.RiskOK = false
		result.addRuleError(rule.RuleID, message(rule, "High-risk workflow is missing approval.request_human_approval"))
	}
}

func (v *RegistryValidator) evalAuditRule(rule registry.Rule, blueprint models.WorkflowBlueprint, usedTools []registry.Tool, result *CandidateValidationResult) {
	requiresAudit := false
	for _, tool := range usedTools {
		if !tool.IsReadOnly || riskRank(tool.RiskLevel) >= riskRank("high") {
			requiresAudit = true
			break
		}
	}
	if requiresAudit && !hasAction(blueprint, "audit.write_audit_log") {
		result.PolicyOK = false
		result.addRuleError(rule.RuleID, message(rule, "Write or high-risk workflow is missing audit.write_audit_log"))
	}
}

func (r *CandidateValidationResult) addError(code, text string) {
	item := code + ": " + text
	if !containsString(r.Errors, item) {
		r.Errors = append(r.Errors, item)
	}
}

func (r *CandidateValidationResult) addRuleError(ruleID, text string) {
	if !containsString(r.Errors, text) {
		r.Errors = append(r.Errors, text)
	}
	if ruleID != "" && !containsString(r.FailedRules, ruleID) {
		r.FailedRules = append(r.FailedRules, ruleID)
	}
}

func (r *CandidateValidationResult) finish() {
	r.FailedRules = uniqueStrings(r.FailedRules)
	r.Score = calculateScore(r)
	r.Passed = r.SchemaOK && r.ToolValidityOK && r.ParametersOK && r.RBACOK && r.PolicyOK && r.ProcessOrderOK && r.RiskOK && len(r.Errors) == 0
}

func calculateScore(r *CandidateValidationResult) float64 {
	score := 0.0
	if r.SchemaOK {
		score += 0.20
	}
	if r.ToolValidityOK {
		score += 0.20
	}
	if r.ParametersOK {
		score += 0.20
	}
	if r.RBACOK {
		score += 0.15
	}
	if r.PolicyOK {
		score += 0.15
	}
	if r.ProcessOrderOK {
		score += 0.05
	}
	if r.RiskOK {
		score += 0.05
	}
	return math.Round(score*100) / 100
}

func isEmptyValue(value interface{}) bool {
	if value == nil {
		return true
	}
	if text, ok := value.(string); ok {
		text = strings.TrimSpace(text)
		return text == "" || text == "<nil>" || strings.EqualFold(text, "null")
	}
	return false
}

func containsSensitiveKey(value interface{}) bool {
	switch typed := value.(type) {
	case map[string]interface{}:
		for key, item := range typed {
			if isSensitiveKey(key) || containsSensitiveKey(item) {
				return true
			}
		}
	case []interface{}:
		for _, item := range typed {
			if containsSensitiveKey(item) {
				return true
			}
		}
	}
	return false
}

func isSensitiveKey(key string) bool {
	key = strings.ToLower(strings.TrimSpace(key))
	sensitive := []string{"password", "token", "api_key", "apikey", "secret", "authorization", "auth_header", "private_key"}
	for _, item := range sensitive {
		if strings.Contains(key, item) {
			return true
		}
	}
	return false
}

func roleIsAllowed(userRole string, allowed []string) bool {
	if len(allowed) == 0 {
		return true
	}
	role := normalizeRole(userRole)
	if role == "admin" || role == "platform_admin" {
		return true
	}
	for _, item := range allowed {
		if normalizeRole(item) == role {
			return true
		}
	}
	return false
}

func roleMatchesAny(userRole string, roles []string) bool {
	role := normalizeRole(userRole)
	for _, item := range roles {
		if normalizeRole(item) == role {
			return true
		}
	}
	return false
}

func normalizeRole(role string) string {
	role = strings.ToLower(strings.TrimSpace(role))
	role = strings.ReplaceAll(role, " ", "_")
	role = strings.ReplaceAll(role, "-", "_")
	if role == "platform_admin" {
		return "admin"
	}
	return role
}

func ruleAppliesToTool(rule registry.Rule, tool registry.Tool) bool {
	if len(rule.AppliesToTools) == 0 {
		return true
	}
	for _, item := range rule.AppliesToTools {
		if strings.EqualFold(item, tool.Name) || strings.EqualFold(item, tool.ToolID) || strings.EqualFold(item, tool.MCPToolName) {
			return true
		}
	}
	return false
}

func ruleAppliesToCandidate(rule registry.Rule, usedTools []registry.Tool, userRole, estimatedRisk string) bool {
	if len(usedTools) == 0 && !mandatoryGlobalRule(rule) {
		return false
	}

	if len(rule.AppliesToRoles) > 0 && !roleMatchesAny(userRole, rule.AppliesToRoles) {
		return false
	}

	if len(rule.AppliesToTools) > 0 {
		for _, tool := range usedTools {
			if ruleAppliesToTool(rule, tool) {
				return true
			}
		}
		return false
	}

	if strings.EqualFold(rule.Domain, "global") || strings.HasPrefix(strings.ToUpper(strings.TrimSpace(rule.RuleID)), "GLOBAL-") {
		return mandatoryGlobalRule(rule) || riskRuleApplies(rule, estimatedRisk)
	}

	if strings.TrimSpace(rule.Domain) != "" {
		return candidateUsesDomain(rule.Domain, usedTools)
	}

	return false
}

func mandatoryGlobalRule(rule registry.Rule) bool {
	switch strings.ToUpper(strings.TrimSpace(rule.RuleID)) {
	case "GLOBAL-SAFETY-001",
		"GLOBAL-SAFETY-003",
		"GLOBAL-SAFETY-008",
		"GLOBAL-SAFETY-009",
		"GLOBAL-SAFETY-010",
		"GLOBAL-SCORING-008",
		"GLOBAL-SCORING-009",
		"GLOBAL-SCORING-010":
		return true
	default:
		return false
	}
}

func riskRuleApplies(rule registry.Rule, estimatedRisk string) bool {
	if rule.RuleType != "risk_escalation" && rule.RuleType != "audit" {
		return false
	}
	value := strings.ToLower(strings.TrimSpace(fmt.Sprint(rule.Condition.Value)))
	if value == "" || value == "<nil>" {
		return riskRank(estimatedRisk) >= riskRank("high")
	}
	return riskRank(estimatedRisk) >= riskRank(value)
}

func candidateUsesDomain(domain string, usedTools []registry.Tool) bool {
	domain = strings.ToLower(strings.TrimSpace(domain))
	for _, tool := range usedTools {
		if strings.EqualFold(tool.Module, domain) || strings.EqualFold(tool.ERPSystem, domain) {
			return true
		}
		if strings.Contains(strings.ToLower(tool.ERPSystem), domain) {
			return true
		}
	}
	return false
}

func containsString(items []string, needle string) bool {
	for _, item := range items {
		if item == needle {
			return true
		}
	}
	return false
}

func interfaceSliceToStrings(value interface{}) []string {
	switch typed := value.(type) {
	case []string:
		return typed
	case []interface{}:
		out := []string{}
		for _, item := range typed {
			out = append(out, fmt.Sprint(item))
		}
		return out
	case string:
		if typed == "" {
			return nil
		}
		return []string{typed}
	default:
		return nil
	}
}

func numeric(value interface{}) (float64, bool) {
	switch typed := value.(type) {
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case jsonNumber:
		parsed, err := typed.Float64()
		return parsed, err == nil
	case string:
		if strings.HasPrefix(typed, "{{") {
			return 0, false
		}
		var parsed float64
		_, err := fmt.Sscanf(typed, "%f", &parsed)
		return parsed, err == nil
	default:
		return 0, false
	}
}

type jsonNumber interface {
	Float64() (float64, error)
}

func compareNumber(left float64, operator string, right float64) bool {
	switch operator {
	case ">":
		return left > right
	case ">=":
		return left >= right
	case "<":
		return left < right
	case "<=":
		return left <= right
	case "==":
		return left == right
	case "!=":
		return left != right
	default:
		return false
	}
}

func hasApprovalStep(blueprint models.WorkflowBlueprint) bool {
	for _, step := range blueprint.Steps {
		action := strings.ToLower(step.Action)
		if action == "approval.request_human_approval" || strings.Contains(action, "approve") || strings.Contains(action, "approval") {
			return true
		}
	}
	return false
}

func hasAction(blueprint models.WorkflowBlueprint, action string) bool {
	for _, step := range blueprint.Steps {
		if strings.EqualFold(step.Action, action) {
			return true
		}
	}
	return false
}

func higherRisk(a, b string) string {
	if riskRank(b) > riskRank(a) {
		return strings.ToLower(b)
	}
	return strings.ToLower(a)
}

func riskRank(risk string) int {
	switch strings.ToLower(strings.TrimSpace(risk)) {
	case "critical":
		return 4
	case "high":
		return 3
	case "medium":
		return 2
	case "low":
		return 1
	default:
		return 0
	}
}

func minIndex(items []int) int {
	min := items[0]
	for _, item := range items {
		if item < min {
			min = item
		}
	}
	return min
}

func maxIndex(items []int) int {
	max := items[0]
	for _, item := range items {
		if item > max {
			max = item
		}
	}
	return max
}

func uniqueStrings(items []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, item := range items {
		if seen[item] {
			continue
		}
		seen[item] = true
		out = append(out, item)
	}
	sort.Strings(out)
	return out
}

func message(rule registry.Rule, fallback string) string {
	if rule.ValidatorMessage != "" {
		return rule.ValidatorMessage
	}
	return fallback
}

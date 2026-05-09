package orchestrator

import (
	"context"
	"fmt"
	"strings"

	"github.com/sanjeewa/agentic-orchestrator/internal/core/registry"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/semanticsearch"
	"github.com/sanjeewa/agentic-orchestrator/internal/core/synthesizer"
	workflowvalidator "github.com/sanjeewa/agentic-orchestrator/internal/core/validator"
)

type ChatOrchestrator struct {
	Search    *semanticsearch.Service
	Generator *synthesizer.Service
	Validator *workflowvalidator.RegistryValidator
	Selector  CandidateSelector
}

func NewChatOrchestrator(search *semanticsearch.Service, generator *synthesizer.Service, validator *workflowvalidator.RegistryValidator) *ChatOrchestrator {
	return &ChatOrchestrator{
		Search:    search,
		Generator: generator,
		Validator: validator,
		Selector:  NewCandidateSelector(),
	}
}

func (o *ChatOrchestrator) HandleChatMessage(ctx context.Context, req ChatRequest) (ChatResponse, error) {
	if req.TopKTools <= 0 {
		req.TopKTools = 10
	}
	if req.TopKRules <= 0 {
		req.TopKRules = 15
	}
	if req.TopKTemplates <= 0 {
		req.TopKTemplates = 5
	}
	if req.TopKExamples <= 0 {
		req.TopKExamples = 5
	}
	if req.GenerateCount <= 0 {
		req.GenerateCount = 5
	}

	retrieval, err := o.Search.SearchContext(ctx, req.UserText, req.UserRole, semanticsearch.Options{
		TopKTools:     req.TopKTools,
		TopKRules:     req.TopKRules,
		TopKTemplates: req.TopKTemplates,
		TopKExamples:  req.TopKExamples,
	})
	if err != nil {
		return ChatResponse{}, err
	}

	retrieval.Tools = o.backfillExecutableToolResults(req.UserText, req.UserRole, retrieval.Tools, 3)
	retrievedTools := toolsFromResults(retrieval.Tools)
	executableTools, schemaMissingTools, futureCapabilities := splitToolsByStatus(retrievedTools)
	domain := detectRequestDomain(req.UserText, retrievedTools, rulesFromResults(retrieval.Rules))
	filteredRules := filterPromptRules(rulesFromResults(retrieval.Rules), executableTools, domain, req.UserRole)
	filteredGlobalRules := filterGlobalPromptRules(rulesFromResults(retrieval.GlobalRules))

	if len(executableTools) == 0 {
		if capabilityTool, ok := o.executableCapabilityRequestTool(); ok {
			executableTools = []registry.Tool{capabilityTool}
			filteredRules = nil
		}
	}

	if len(executableTools) == 0 {
		return ChatResponse{
			SessionID:         req.SessionID,
			Retrieval:         retrieval,
			CanExecute:        false,
			NextAction:        "capability_request_or_schema_generation",
			AssistantMessage:  "I found relevant dataset tools, but none are currently executable. The request needs MCP schema generation or a future capability implementation before workflow execution.",
			BlockingErrors:    noExecutableToolErrors(schemaMissingTools, futureCapabilities),
			Candidates:        []CandidateReport{},
			RawCandidates:     []synthesizer.WorkflowCandidate{},
			ValidationSummary: ValidationSummary{},
		}, nil
	}

	candidates, err := o.Generator.GenerateCandidates(ctx, synthesizer.CandidateGenerationRequest{
		Prompt:             req.UserText,
		UserRole:           req.UserRole,
		Mode:               req.Mode,
		Model:              req.Model,
		CandidateCount:     req.GenerateCount,
		Tools:              executableTools,
		MissingSchemaTools: schemaMissingTools,
		FutureCapabilities: futureCapabilities,
		Rules:              filteredRules,
		GlobalRules:        filteredGlobalRules,
		Templates:          templatesFromResults(retrieval.Templates),
		Examples:           examplesFromResults(retrieval.Examples),
	})
	if err != nil {
		return ChatResponse{}, err
	}

	reports := make([]CandidateReport, 0, len(candidates))
	for _, candidate := range candidates {
		validation := o.Validator.ValidateCandidate(candidate.CandidateID, candidate.RawYAML, req.UserRole)
		reports = append(reports, CandidateReport{
			CandidateID: candidate.CandidateID,
			YAML:        candidate.RawYAML,
			Generation:  candidate.GenerationMetadata,
			Validation:  validation,
		})
	}

	selected, ok := o.Selector.Select(reports)
	response := ChatResponse{
		SessionID:     req.SessionID,
		Retrieval:     retrieval,
		Candidates:    reports,
		RawCandidates: candidates,
	}

	for _, report := range reports {
		if report.Validation.Passed {
			response.ValidationSummary.PassedCandidates++
		} else {
			response.ValidationSummary.BlockedCandidates++
			response.BlockingErrors = append(response.BlockingErrors, report.Validation.Errors...)
		}
		if report.Validation.Score > response.ValidationSummary.BestScore {
			response.ValidationSummary.BestScore = report.Validation.Score
		}
	}

	if ok {
		response.SelectedCandidateID = selected.CandidateID
		response.SelectedWorkflowYAML = selected.YAML
		response.CanExecute = true
		response.AssistantMessage = "I generated and validated workflow candidates. The best valid workflow is ready for review."
		return response, nil
	}

	response.CanExecute = false
	response.NextAction = "regenerate_or_request_clarification"
	response.AssistantMessage = "I generated workflow candidates, but none passed full semantic validation. Review the blocking errors and regenerate or clarify the request."
	if len(response.BlockingErrors) == 0 {
		response.BlockingErrors = []string{"No candidate passed full semantic validation."}
	}
	response.BlockingErrors = uniqueStrings(response.BlockingErrors)
	return response, nil
}

func (o *ChatOrchestrator) backfillExecutableToolResults(query, userRole string, current []semanticsearch.ToolResult, max int) []semanticsearch.ToolResult {
	if o == nil || o.Search == nil || o.Search.Tools == nil || max <= 0 {
		return current
	}
	seen := map[string]bool{}
	for _, item := range current {
		seen[strings.ToLower(firstNonEmpty(item.ToolID, item.Name, item.MCPToolName))] = true
	}

	added := 0
	for _, tool := range o.Search.Tools.GetAllTools() {
		key := strings.ToLower(firstNonEmpty(tool.ToolID, tool.Name, tool.MCPToolName))
		if key == "" || seen[key] || !toolIsExecutable(tool) {
			continue
		}
		if !toolRoleAllowed(userRole, tool.AllowedRoles) || !toolMatchesRequest(query, tool) {
			continue
		}
		current = append([]semanticsearch.ToolResult{{
			Tool:        tool,
			Score:       0.99,
			MatchReason: "Executable registry backfill matched the user intent",
		}}, current...)
		seen[key] = true
		added++
		if added == max {
			break
		}
	}
	return current
}

func (o *ChatOrchestrator) executableCapabilityRequestTool() (registry.Tool, bool) {
	if o == nil || o.Validator == nil || o.Validator.Tools == nil {
		return registry.Tool{}, false
	}
	tool, ok := o.Validator.Tools.FindToolByName("capability.create_capability_request")
	if !ok {
		return registry.Tool{}, false
	}
	if toolIsExecutable(tool) {
		return tool, true
	}
	return registry.Tool{}, false
}

func splitToolsByStatus(items []registry.Tool) (executable []registry.Tool, schemaMissing []registry.Tool, future []registry.Tool) {
	seen := map[string]bool{}
	for _, tool := range items {
		key := strings.ToLower(strings.TrimSpace(firstNonEmpty(tool.Name, tool.ToolID)))
		if key == "" || seen[key] {
			continue
		}
		seen[key] = true
		switch strings.ToLower(strings.TrimSpace(tool.Status)) {
		case "", "active_mcp_schema_present":
			executable = append(executable, tool)
		case "mock_endpoint_available_schema_missing":
			schemaMissing = append(schemaMissing, tool)
		default:
			future = append(future, tool)
		}
	}
	return executable, schemaMissing, future
}

func toolIsExecutable(tool registry.Tool) bool {
	switch strings.ToLower(strings.TrimSpace(tool.Status)) {
	case "", "active_mcp_schema_present":
		return true
	default:
		return false
	}
}

func toolRoleAllowed(userRole string, allowed []string) bool {
	if len(allowed) == 0 {
		return true
	}
	role := normalizeRole(userRole)
	if role == "admin" {
		return true
	}
	for _, item := range allowed {
		if normalizeRole(item) == role {
			return true
		}
	}
	return false
}

func toolMatchesRequest(query string, tool registry.Tool) bool {
	query = strings.ToLower(query)
	if query == "" {
		return false
	}

	nameTokens := significantTokens(tool.Name)
	if len(nameTokens) > 0 && allTokensPresent(query, nameTokens) {
		return true
	}
	capabilityTokens := significantTokens(tool.BusinessCapability)
	if len(capabilityTokens) > 0 && allTokensPresent(query, capabilityTokens) {
		return true
	}
	for _, keyword := range tool.SemanticSearchKeywords {
		keywordTokens := significantTokens(keyword)
		if len(keywordTokens) > 0 && allTokensPresent(query, keywordTokens) {
			return true
		}
	}
	return false
}

func significantTokens(value string) []string {
	value = strings.ToLower(value)
	replacer := strings.NewReplacer(".", " ", "_", " ", "-", " ", "/", " ", "&", " ")
	value = replacer.Replace(value)
	stop := map[string]bool{
		"api": true, "erp": true, "mcp": true, "tool": true, "workflow": true,
		"finance": true, "procurement": true, "inventory": true, "travel": true, "hr": true,
	}
	tokens := []string{}
	for _, token := range strings.Fields(value) {
		token = strings.TrimSpace(token)
		if len(token) < 3 || stop[token] {
			continue
		}
		if token == "invoices" {
			token = "invoice"
		}
		tokens = append(tokens, token)
	}
	return tokens
}

func allTokensPresent(text string, tokens []string) bool {
	for _, token := range tokens {
		if !strings.Contains(text, token) {
			return false
		}
	}
	return true
}

func detectRequestDomain(query string, tools []registry.Tool, rules []registry.Rule) string {
	lower := strings.ToLower(query)
	for _, domain := range []string{"procurement", "finance", "inventory", "hr", "travel"} {
		if strings.Contains(lower, domain) || strings.Contains(lower, strings.ReplaceAll(domain, "_", " ")) {
			return domain
		}
	}
	for _, tool := range tools {
		if strings.TrimSpace(tool.Module) != "" {
			return strings.ToLower(strings.TrimSpace(tool.Module))
		}
	}
	for _, rule := range rules {
		if strings.TrimSpace(rule.Domain) != "" && !strings.EqualFold(rule.Domain, "global") {
			return strings.ToLower(strings.TrimSpace(rule.Domain))
		}
	}
	return ""
}

func filterPromptRules(rules []registry.Rule, executableTools []registry.Tool, domain, userRole string) []registry.Rule {
	out := []registry.Rule{}
	seen := map[string]bool{}
	for _, rule := range rules {
		if seen[rule.RuleID] || !rule.Enabled {
			continue
		}
		if !ruleApplicableToPrompt(rule, executableTools, domain, userRole) {
			continue
		}
		seen[rule.RuleID] = true
		out = append(out, rule)
	}
	return out
}

func filterGlobalPromptRules(rules []registry.Rule) []registry.Rule {
	mandatory := map[string]bool{
		"GLOBAL-SAFETY-001":  true,
		"GLOBAL-SAFETY-003":  true,
		"GLOBAL-SAFETY-008":  true,
		"GLOBAL-SAFETY-009":  true,
		"GLOBAL-SAFETY-010":  true,
		"GLOBAL-SCORING-008": true,
		"GLOBAL-SCORING-009": true,
		"GLOBAL-SCORING-010": true,
	}
	out := []registry.Rule{}
	seen := map[string]bool{}
	for _, rule := range rules {
		if mandatory[rule.RuleID] && !seen[rule.RuleID] {
			seen[rule.RuleID] = true
			out = append(out, rule)
		}
	}
	return out
}

func ruleApplicableToPrompt(rule registry.Rule, tools []registry.Tool, domain, userRole string) bool {
	if len(rule.AppliesToTools) > 0 {
		for _, tool := range tools {
			for _, ref := range rule.AppliesToTools {
				if strings.EqualFold(ref, tool.Name) || strings.EqualFold(ref, tool.ToolID) || strings.EqualFold(ref, tool.MCPToolName) {
					return true
				}
			}
		}
		return false
	}
	if rule.Domain != "" && domain != "" && !strings.EqualFold(rule.Domain, "global") && !strings.EqualFold(rule.Domain, domain) {
		return false
	}
	if len(rule.AppliesToRoles) > 0 && userRole != "" {
		for _, role := range rule.AppliesToRoles {
			if normalizeRole(role) == normalizeRole(userRole) {
				return true
			}
		}
		return false
	}
	return true
}

func noExecutableToolErrors(schemaMissing, future []registry.Tool) []string {
	errors := []string{"No retrieved tool has status active_mcp_schema_present, so no executable workflow candidate was generated."}
	if len(schemaMissing) > 0 {
		errors = append(errors, fmt.Sprintf("%d retrieved tool(s) have mock endpoints but missing MCP schemas: %s", len(schemaMissing), toolNameList(schemaMissing, 5)))
	}
	if len(future) > 0 {
		errors = append(errors, fmt.Sprintf("%d retrieved tool(s) are recommended future capabilities and cannot execute directly: %s", len(future), toolNameList(future, 5)))
	}
	return errors
}

func toolNameList(tools []registry.Tool, max int) string {
	names := []string{}
	for index, tool := range tools {
		if index == max {
			names = append(names, "...")
			break
		}
		names = append(names, tool.Name)
	}
	return strings.Join(names, ", ")
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

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
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
	return out
}

func toolsFromResults(items []semanticsearch.ToolResult) []registry.Tool {
	out := make([]registry.Tool, 0, len(items))
	for _, item := range items {
		out = append(out, item.Tool)
	}
	return out
}

func rulesFromResults(items []semanticsearch.RuleResult) []registry.Rule {
	out := make([]registry.Rule, 0, len(items))
	for _, item := range items {
		out = append(out, item.Rule)
	}
	return out
}

func templatesFromResults(items []semanticsearch.TemplateResult) []registry.ProcessTemplate {
	out := make([]registry.ProcessTemplate, 0, len(items))
	for _, item := range items {
		out = append(out, item.ProcessTemplate)
	}
	return out
}

func examplesFromResults(items []semanticsearch.ExampleResult) []registry.FewShotExample {
	out := make([]registry.FewShotExample, 0, len(items))
	for _, item := range items {
		out = append(out, item.FewShotExample)
	}
	return out
}

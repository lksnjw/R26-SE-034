package semanticsearch

import "github.com/sanjeewa/agentic-orchestrator/internal/core/registry"

type Options struct {
	TopKTools     int
	TopKRules     int
	TopKTemplates int
	TopKExamples  int
	Mode          string
}

type ToolResult struct {
	registry.Tool
	Score       float64 `json:"score"`
	MatchReason string  `json:"match_reason"`
}

type RuleResult struct {
	registry.Rule
	Score       float64 `json:"score"`
	MatchReason string  `json:"match_reason"`
}

type TemplateResult struct {
	registry.ProcessTemplate
	Score       float64 `json:"score"`
	MatchReason string  `json:"match_reason"`
}

type ExampleResult struct {
	registry.FewShotExample
	Score       float64 `json:"score"`
	MatchReason string  `json:"match_reason"`
}

type Result struct {
	Tools           []ToolResult     `json:"tools"`
	Rules           []RuleResult     `json:"rules"`
	GlobalRules     []RuleResult     `json:"global_rules"`
	Templates       []TemplateResult `json:"templates"`
	Examples        []ExampleResult  `json:"examples"`
	Query           string           `json:"query"`
	UserRole        string           `json:"user_role"`
	Method          string           `json:"method,omitempty"`
	RetrievalMethod string           `json:"retrieval_method"`
}

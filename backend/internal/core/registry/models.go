package registry

type Tool struct {
	ToolID                    string                 `json:"tool_id"`
	Name                      string                 `json:"name"`
	DisplayName               string                 `json:"display_name"`
	ERPSystem                 string                 `json:"erp_system,omitempty"`
	Module                    string                 `json:"module"`
	Status                    string                 `json:"status"`
	Description               string                 `json:"description"`
	BusinessCapability        string                 `json:"business_capability"`
	BPIProcessAlignment       []string               `json:"bpi_process_alignment"`
	Endpoint                  string                 `json:"endpoint"`
	HTTPMethod                string                 `json:"http_method"`
	MCPToolName               string                 `json:"mcp_tool_name"`
	InputSchema               map[string]interface{} `json:"input_schema"`
	RequiredParameters        []string               `json:"required_parameters"`
	OptionalParameters        []string               `json:"optional_parameters"`
	AllowedRoles              []string               `json:"allowed_roles"`
	RiskLevel                 string                 `json:"risk_level"`
	IsReadOnly                bool                   `json:"is_read_only"`
	SideEffects               []string               `json:"side_effects"`
	Preconditions             []string               `json:"preconditions"`
	Postconditions            []string               `json:"postconditions"`
	FailureModes              []string               `json:"failure_modes"`
	ValidatorChecks           []string               `json:"validator_checks"`
	PromptUsageGuidance       string                 `json:"prompt_usage_guidance"`
	SemanticSearchKeywords    []string               `json:"semantic_search_keywords"`
	SemanticSearchDescription string                 `json:"semantic_search_description"`
	ExecutionNotes            string                 `json:"execution_notes"`
	CurrentGaps               []string               `json:"current_gaps"`
	SourceFile                string                 `json:"source_file,omitempty"`
}

type RuleCondition struct {
	Type      string      `json:"type"`
	Parameter string      `json:"parameter"`
	Operator  string      `json:"operator"`
	Value     interface{} `json:"value"`
}

type Rule struct {
	RuleID               string        `json:"rule_id"`
	RuleName             string        `json:"rule_name"`
	RuleType             string        `json:"rule_type"`
	ERPSystem            string        `json:"erp_system,omitempty"`
	Domain               string        `json:"domain"`
	Description          string        `json:"description"`
	AppliesToTools       []string      `json:"applies_to_tools"`
	AppliesToRoles       []string      `json:"applies_to_roles"`
	Condition            RuleCondition `json:"condition"`
	EnforcementAction    string        `json:"enforcement_action"`
	Severity             string        `json:"severity"`
	ValidatorMessage     string        `json:"validator_message"`
	LLMPromptInstruction string        `json:"llm_prompt_instruction"`
	HealingGuidance      string        `json:"healing_guidance"`
	BPIAlignment         []string      `json:"bpi_alignment"`
	AuditFieldsRequired  []string      `json:"audit_fields_required"`
	Enabled              bool          `json:"enabled"`
	SourceFile           string        `json:"source_file,omitempty"`
}

type ProcessTemplate struct {
	TemplateID         string        `json:"template_id"`
	TemplateName       string        `json:"template_name"`
	ERPSystemsInvolved []string      `json:"erp_systems_involved"`
	BPIAlignment       string        `json:"bpi_alignment"`
	Description        string        `json:"description"`
	RequiredTools      []string      `json:"required_tools"`
	RequiredRules      []string      `json:"required_rules"`
	NormalFlow         []interface{} `json:"normal_flow"`
	ExceptionFlows     []interface{} `json:"exception_flows"`
	ApprovalPoints     []interface{} `json:"approval_points"`
	ValidationFocus    []string      `json:"validation_focus"`
	SampleUserIntents  []string      `json:"sample_user_intents"`
	SourceFile         string        `json:"source_file,omitempty"`
}

type FewShotExample struct {
	ScenarioID       string   `json:"scenario_id"`
	UserRole         string   `json:"user_role"`
	UserRequest      string   `json:"user_request"`
	ExpectedDomain   string   `json:"expected_domain"`
	ExpectedIntent   string   `json:"expected_intent"`
	ExpectedTools    []string `json:"expected_tools"`
	ExpectedRules    []string `json:"expected_rules"`
	ExpectedDecision string   `json:"expected_decision"`
	RiskLevel        string   `json:"risk_level"`
	BPIAlignment     []string `json:"bpi_alignment"`
	Notes            string   `json:"notes"`
	SourceFile       string   `json:"source_file,omitempty"`
}

type RegistryVersions struct {
	Tools     string `json:"tools"`
	Rules     string `json:"rules"`
	Templates string `json:"templates,omitempty"`
	Examples  string `json:"examples,omitempty"`
}

package synthesizer

import (
	"fmt"
	"strings"
)

type PromptBuilder struct {
	SkillCatalog []string
}

func NewPromptBuilder() PromptBuilder {
	return PromptBuilder{
		SkillCatalog: []string{
			"fetch_attendance",
			"create_leave",
			"classify_invoice",
			"policy_check",
			"refresh_connector",
			"notify_finance",
			"create_invoice",
			"fetch_supplier",
			"send_webhook",
		},
	}
}

func (b PromptBuilder) Build(userPrompt, mode string, context map[string]interface{}) string {
	if mode == "" {
		mode = "balanced"
	}

	return fmt.Sprintf(`You are the Agentic Workflow Engine synthesis agent.

Return ONLY valid YAML. Do not use markdown fences. Do not explain.

Allowed actions:
%s

Required YAML schema:
name: string
description: string
trigger:
  type: string
  displayName: string
  config: object
steps:
  - id: string
    action: string
    parameters: object
    retryCount: number
    onError: string

Governance:
- Never invent direct ERP database access.
- Use MCP bridge actions only.
- Include policy_check before production writes.
- Include retryCount on external connector calls.

Mode: %s
Context: %+v
User request: %s
`, "- "+strings.Join(b.SkillCatalog, "\n- "), mode, context, userPrompt)
}

func FallbackYAML(userPrompt string) string {
	title := "generated_workflow"
	if strings.Contains(strings.ToLower(userPrompt), "leave") {
		title = "leave_approval_workflow"
	}
	if strings.Contains(strings.ToLower(userPrompt), "invoice") {
		title = "invoice_exception_resolver"
	}

	return fmt.Sprintf(`name: %s
description: Generated from natural language by the Agentic Orchestrator.
trigger:
  type: user.requested
  displayName: Natural language request
  config:
    source: frontend
steps:
  - id: classify_intent
    action: classify_invoice
    parameters:
      prompt: %q
    retryCount: 1
  - id: policy_guardrail
    action: policy_check
    parameters:
      intent: "{{classify_intent.intent}}"
    retryCount: 1
  - id: execute_mcp_action
    action: fetch_attendance
    parameters:
      employeeId: "{{input.employeeId}}"
    retryCount: 2
    onError: self_heal
  - id: notify_owner
    action: notify_finance
    parameters:
      message: Workflow completed safely
    retryCount: 1
`, title, userPrompt)
}

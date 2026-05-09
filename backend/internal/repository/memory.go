package repository

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

type Store struct {
	Mu sync.RWMutex

	Counter int

	Users         map[string]*models.User
	Roles         map[string]*models.Role
	Permissions   []models.Permission
	Workflows     map[string]*models.Workflow
	Versions      map[string][]models.WorkflowVersion
	Templates     map[string]*models.WorkflowTemplate
	Executions    map[string]*models.Execution
	ExecutionLogs map[string][]models.ExecutionLog
	Timelines     map[string][]models.ExecutionStep
	Healing       map[string]models.HealingReport
	Chats         map[string]*models.ChatSessionDetail
	Settings      models.SettingsBundle
	Integrations  map[string]*models.Integration
	Webhooks      map[string]*models.Webhook
	AuditLogs     map[string]*models.AuditLog
	Notifications map[string]*models.Notification
	APIKeys       map[string]*models.APIKey
	Uploads       map[string]*models.UploadedFile
}

func NewStore() *Store {
	now := time.Now().UTC()
	lastLogin := now.Add(-40 * time.Minute)
	lastRun := now.Add(-2 * time.Minute)
	lastTested := now.Add(-20 * time.Minute)
	adminPermissions := []string{"workflow:read", "workflow:write", "workflow:run", "settings:manage", "user:manage", "audit:read"}

	store := &Store{
		Counter:       1000,
		Users:         map[string]*models.User{},
		Roles:         map[string]*models.Role{},
		Workflows:     map[string]*models.Workflow{},
		Versions:      map[string][]models.WorkflowVersion{},
		Templates:     map[string]*models.WorkflowTemplate{},
		Executions:    map[string]*models.Execution{},
		ExecutionLogs: map[string][]models.ExecutionLog{},
		Timelines:     map[string][]models.ExecutionStep{},
		Healing:       map[string]models.HealingReport{},
		Chats:         map[string]*models.ChatSessionDetail{},
		Integrations:  map[string]*models.Integration{},
		Webhooks:      map[string]*models.Webhook{},
		AuditLogs:     map[string]*models.AuditLog{},
		Notifications: map[string]*models.Notification{},
		APIKeys:       map[string]*models.APIKey{},
		Uploads:       map[string]*models.UploadedFile{},
	}

	store.Permissions = []models.Permission{
		{Key: "workflow:read", Name: "Read workflows", Group: "Workflow"},
		{Key: "workflow:write", Name: "Create and edit workflows", Group: "Workflow"},
		{Key: "workflow:run", Name: "Run workflows", Group: "Execution"},
		{Key: "settings:manage", Name: "Manage settings", Group: "Admin"},
		{Key: "user:manage", Name: "Manage users", Group: "Admin"},
		{Key: "audit:read", Name: "Read audit logs", Group: "Governance"},
	}

	store.Roles["role_admin"] = &models.Role{ID: "role_admin", Name: "Platform Admin", Description: "Full platform administrator", Permissions: adminPermissions, CreatedAt: now.Add(-24 * time.Hour)}
	store.Roles["role_builder"] = &models.Role{ID: "role_builder", Name: "Workflow Builder", Description: "Builds and tests workflows", Permissions: []string{"workflow:read", "workflow:write", "workflow:run"}, CreatedAt: now.Add(-24 * time.Hour)}
	store.Roles["role_reviewer"] = &models.Role{ID: "role_reviewer", Name: "Execution Reviewer", Description: "Reviews production executions", Permissions: []string{"workflow:read", "audit:read"}, CreatedAt: now.Add(-24 * time.Hour)}
	store.Roles["role_auditor"] = &models.Role{ID: "role_auditor", Name: "Auditor", Description: "Reads immutable audit history", Permissions: []string{"audit:read"}, CreatedAt: now.Add(-24 * time.Hour)}

	store.Users["usr_001"] = &models.User{ID: "usr_001", Name: "Lakshan Jay", Email: "admin@workflow.local", Role: models.RoleRef{ID: "role_admin", Name: "Platform Admin"}, Permissions: adminPermissions, Status: "Active", Initials: "LJ", LastLoginAt: &lastLogin, CreatedAt: now.Add(-48 * time.Hour), TwoFactorEnabled: true, EmailVerified: true}
	store.Users["usr_002"] = &models.User{ID: "usr_002", Name: "Maya Silva", Email: "maya@workflow.local", Role: models.RoleRef{ID: "role_builder", Name: "Workflow Builder"}, Permissions: store.Roles["role_builder"].Permissions, Status: "Active", Initials: "MS", LastLoginAt: &lastLogin, CreatedAt: now.Add(-44 * time.Hour), EmailVerified: true}
	store.Users["usr_003"] = &models.User{ID: "usr_003", Name: "Naveen Perera", Email: "naveen@workflow.local", Role: models.RoleRef{ID: "role_reviewer", Name: "Execution Reviewer"}, Permissions: store.Roles["role_reviewer"].Permissions, Status: "Invited", Initials: "NP", CreatedAt: now.Add(-6 * time.Hour)}
	store.Users["usr_004"] = &models.User{ID: "usr_004", Name: "Asha Fernando", Email: "asha@workflow.local", Role: models.RoleRef{ID: "role_auditor", Name: "Auditor"}, Permissions: store.Roles["role_auditor"].Permissions, Status: "Active", Initials: "AF", LastLoginAt: &lastLogin, CreatedAt: now.Add(-22 * time.Hour), EmailVerified: true}

	invoiceYAML := `name: erp_invoice_exception_resolver
description: Resolve ERP invoice exceptions with policy checks, connector retry, finance notification, and audit logging.
trigger:
  type: erp.invoice.created
  displayName: New invoice anomaly
steps:
  - id: classify_intent
    action: classify_invoice
    parameters:
      invoiceId: "{{input.invoiceId}}"
  - id: policy_guardrail
    action: policy_check
    parameters:
      amount: "{{classify_intent.amount}}"
  - id: repair_connector
    action: refresh_connector
    retryCount: 2
  - id: notify_owner
    action: notify_finance
    parameters:
      message: Invoice exception requires review
  - id: audit_invoice_exception
    action: audit.write_audit_log
    parameters:
      event_type: invoice_exception_resolution
      actor_role: Workflow Builder
      decision: finance_notified
`
	store.Workflows["wf-101"] = &models.Workflow{
		ID: "wf-101", Name: "ERP Invoice Exception Resolver", Description: "Detects mismatched supplier invoices, classifies root cause, and routes approvals.",
		Owner: models.Principal{ID: "team_ops", Name: "Ops Automation"}, Status: models.StatusRunning,
		Trigger: map[string]interface{}{"type": "erp.invoice.created", "displayName": "New invoice anomaly", "config": map[string]interface{}{"source": "erp-sandbox", "event": "invoice.created"}},
		Steps:   7, SuccessRate: 97.8, LastRunAt: &lastRun, PublishedVersion: 4, DraftVersion: 5, Tags: []string{"erp", "finance", "self-healing"},
		YAML: invoiceYAML, Canvas: sampleCanvas("wf-101"), CreatedAt: now.Add(-28 * time.Hour), UpdatedAt: now.Add(-2 * time.Minute),
	}
	store.Workflows["wf-102"] = &models.Workflow{ID: "wf-102", Name: "Procurement Risk Escalation", Description: "Scores supplier events and escalates risky decisions to reviewers.", Owner: models.Principal{ID: "team_supply", Name: "Supply Chain"}, Status: models.StatusHealing, Trigger: map[string]interface{}{"type": "erp.vendor.risk_scored", "displayName": "Vendor risk score"}, Steps: 6, SuccessRate: 94.2, LastRunAt: &lastRun, PublishedVersion: 2, DraftVersion: 3, Tags: []string{"erp", "procurement"}, YAML: invoiceYAML, Canvas: sampleCanvas("wf-102"), CreatedAt: now.Add(-24 * time.Hour), UpdatedAt: now.Add(-8 * time.Minute)}
	store.Workflows["wf-103"] = &models.Workflow{ID: "wf-103", Name: "Customer Refund Auto-Triage", Description: "Classifies refund requests and drafts next actions.", Owner: models.Principal{ID: "team_cx", Name: "CX"}, Status: models.StatusDone, Trigger: map[string]interface{}{"type": "support.ticket.created", "displayName": "Support ticket created"}, Steps: 5, SuccessRate: 99.1, LastRunAt: &lastRun, PublishedVersion: 1, DraftVersion: 1, Tags: []string{"support", "policy"}, YAML: invoiceYAML, Canvas: sampleCanvas("wf-103"), CreatedAt: now.Add(-20 * time.Hour), UpdatedAt: now.Add(-18 * time.Minute)}
	store.Workflows["wf-104"] = &models.Workflow{ID: "wf-104", Name: "Inventory Reorder Planner", Description: "Combines demand signals and ERP inventory to recommend safe reorder quantities.", Owner: models.Principal{ID: "team_warehouse", Name: "Warehouse"}, Status: models.StatusPending, Trigger: map[string]interface{}{"type": "erp.stock.low", "displayName": "Stock below threshold"}, Steps: 8, SuccessRate: 92.6, LastRunAt: &lastRun, PublishedVersion: 1, DraftVersion: 2, Tags: []string{"inventory", "erp"}, YAML: invoiceYAML, Canvas: sampleCanvas("wf-104"), CreatedAt: now.Add(-16 * time.Hour), UpdatedAt: now.Add(-1 * time.Hour)}

	store.Templates["tpl_invoice"] = &models.WorkflowTemplate{ID: "tpl_invoice", Name: "Invoice Exception Resolver", Description: "Duplicate invoice detection with self-healing ERP retry.", Category: "Finance", Tags: []string{"erp", "finance"}, YAML: invoiceYAML, Steps: 7, CreatedAt: now.Add(-30 * time.Hour)}
	store.Templates["tpl_leave"] = &models.WorkflowTemplate{ID: "tpl_leave", Name: "Leave Approval Assistant", Description: "Fetch attendance, validate policy, and create leave request.", Category: "HR", Tags: []string{"hr", "mcp"}, YAML: `name: leave_approval
description: Fetch attendance, create a leave request, and write an audit record.
trigger:
  type: user.requested
  displayName: Leave request
steps:
  - id: fetch_attendance
    action: fetch_attendance
  - id: create_leave
    action: create_leave
  - id: audit_leave
    action: audit.write_audit_log
    parameters:
      event_type: leave_request_created
      actor_role: Workflow Builder
      decision: queued
`, Steps: 3, CreatedAt: now.Add(-26 * time.Hour)}

	store.Executions["run-4821"] = &models.Execution{ID: "run-4821", WorkflowID: "wf-101", WorkflowName: "ERP Invoice Exception Resolver", Status: models.StatusRunning, StartedAt: now.Add(-74 * time.Second), DurationMS: 74000, Tokens: models.Tokens{Input: 5400, Output: 3000, Total: 8400}, CostUSD: 0.31, StartedBy: models.Principal{ID: "usr_001", Name: "Lakshan Jay"}}
	store.ExecutionLogs["run-4821"] = []models.ExecutionLog{
		{ID: "log_001", ExecutionID: "run-4821", Timestamp: now.Add(-74 * time.Second), Level: "info", NodeID: "trigger", Message: "trigger.erp_event received invoice_id=INV-99214", Metadata: map[string]interface{}{"invoiceId": "INV-99214"}},
		{ID: "log_002", ExecutionID: "run-4821", Timestamp: now.Add(-72 * time.Second), Level: "info", NodeID: "classify", Message: "llm.classify_intent confidence=0.94 category=duplicate_invoice", Metadata: map[string]interface{}{"confidence": 0.94}},
		{ID: "log_003", ExecutionID: "run-4821", Timestamp: now.Add(-36 * time.Second), Level: "warn", NodeID: "repair", Message: "healing.retry_connector refreshed ERP token and resumed", Metadata: map[string]interface{}{"reason": "connector_token_expired"}},
	}
	duration := int64(2000)
	completed := now.Add(-72 * time.Second)
	store.Timelines["run-4821"] = []models.ExecutionStep{
		{ID: "step_001", NodeID: "trigger", Label: "ERP Event Trigger", Status: models.StatusDone, StartedAt: now.Add(-74 * time.Second), CompletedAt: &completed, DurationMS: &duration},
		{ID: "step_002", NodeID: "policy", Label: "Policy Guardrail", Status: models.StatusRunning, StartedAt: now.Add(-66 * time.Second)},
	}
	store.Healing["run-4821"] = models.HealingReport{ExecutionID: "run-4821", WorkflowID: "wf-101", Status: "RECOVERED", Summary: "ERP token refresh recovered the connector and resumed execution without duplicate downstream actions.", Events: []map[string]interface{}{{"id": "heal_001", "type": "connector_token_refresh", "nodeId": "repair", "status": "success", "startedAt": now.Add(-47 * time.Second), "completedAt": now.Add(-11 * time.Second)}}, Metrics: map[string]interface{}{"recoveredInSeconds": 36, "duplicateWritesPrevented": true, "ownerNotified": true}}

	store.Chats["chat_001"] = &models.ChatSessionDetail{
		ChatSession: models.ChatSession{ID: "chat_001", Title: "Invoice exception resolver", CreatedAt: now.Add(-12 * time.Minute), UpdatedAt: now.Add(-4 * time.Minute), MessageCount: 3},
		Messages: []models.ChatMessage{
			{ID: "msg_001", Role: "assistant", Text: "Describe the workflow you want and I will turn it into a validated YAML blueprint.", CreatedAt: now.Add(-12 * time.Minute)},
			{ID: "msg_002", Role: "user", Text: "When an ERP invoice is duplicated, classify the reason, retry connector failures, then notify finance.", CreatedAt: now.Add(-10 * time.Minute)},
			{ID: "msg_003", Role: "assistant", Text: "Drafted a 7-step workflow with policy checks, self-healing retry, and human approval routing.", CreatedAt: now.Add(-9 * time.Minute)},
		},
	}

	store.Settings = models.SettingsBundle{
		General: map[string]interface{}{"appName": "Agentic Workflow Engine", "defaultTimezone": "Asia/Colombo", "branding": map[string]interface{}{"primaryColor": "#84006A"}},
		LLM:     map[string]interface{}{"defaultModel": "phi3:mini", "fallbackModel": "gpt-5.4-mini", "policyMode": "guarded", "systemPrompt": "You are the workflow synthesis agent."},
		RBAC:    map[string]interface{}{"productionRunRequiresApproval": true, "defaultRoleId": "role_builder"},
	}
	store.Integrations["int_erp_sandbox"] = &models.Integration{ID: "int_erp_sandbox", Name: "ERP Sandbox", Type: "MCP Server", Status: "Connected", Icon: "mdi:server", Config: map[string]interface{}{"baseUrl": "https://erp.example.local", "timeoutMs": 15000}, LastTestedAt: &lastTested, CreatedAt: now.Add(-24 * time.Hour)}
	store.Integrations["int_github"] = &models.Integration{ID: "int_github", Name: "GitHub Actions", Type: "CI/CD", Status: "Connected", Icon: "mdi:github", Config: map[string]interface{}{"baseUrl": "https://api.github.com"}, LastTestedAt: &lastTested, CreatedAt: now.Add(-22 * time.Hour)}
	store.Webhooks["wh_001"] = &models.Webhook{ID: "wh_001", Name: "Workflow Events", URL: "https://example.com/workflow-events", Events: []string{"execution.started", "execution.completed", "execution.failed", "healing.recovered"}, Enabled: true, SecretPreview: "whsec_....2F91", CreatedAt: now.Add(-30 * time.Minute)}
	store.Notifications["not_001"] = &models.Notification{ID: "not_001", Message: "ERP connector token expires soon", Tone: "warning", Type: "integration.warning", Read: false, Resource: map[string]interface{}{"type": "integration", "id": "int_erp_sandbox"}, CreatedAt: now.Add(-10 * time.Minute)}
	store.APIKeys["key_001"] = &models.APIKey{ID: "key_001", Name: "Local development", MaskedKey: "wf_live_................2F91", Scopes: []string{"workflow:read", "workflow:run"}, CreatedAt: now.Add(-20 * time.Minute)}
	store.AuditLogs["audit_001"] = &models.AuditLog{ID: "audit_001", Actor: models.Principal{ID: "usr_001", Name: "Lakshan Jay"}, Action: "settings.llm.updated", Resource: models.ResourceRef{Type: "settings", ID: "llm"}, IPAddress: "127.0.0.1", UserAgent: "Codex local browser", Before: map[string]interface{}{"model": "gpt-5.4-mini"}, After: map[string]interface{}{"model": "phi3:mini"}, CreatedAt: now.Add(-30 * time.Minute)}

	return store
}

func (s *Store) NextID(prefix string) string {
	s.Counter++
	return fmt.Sprintf("%s_%d", prefix, s.Counter)
}

func (s *Store) Audit(actor models.Principal, action string, resource models.ResourceRef, before, after map[string]interface{}, ip, ua string) {
	id := s.NextID("audit")
	s.AuditLogs[id] = &models.AuditLog{
		ID: id, Actor: actor, Action: action, Resource: resource, IPAddress: ip, UserAgent: ua,
		Before: before, After: after, CreatedAt: time.Now().UTC(),
	}
}

func ListMapValues[T any](items map[string]*T) []T {
	out := make([]T, 0, len(items))
	for _, item := range items {
		out = append(out, *item)
	}
	return out
}

func SortWorkflows(items []models.Workflow) {
	sort.Slice(items, func(i, j int) bool {
		return items[i].UpdatedAt.After(items[j].UpdatedAt)
	})
}

func FilterWorkflows(items []models.Workflow, q, status string) []models.Workflow {
	q = strings.ToLower(strings.TrimSpace(q))
	status = strings.TrimSpace(status)
	out := make([]models.Workflow, 0, len(items))
	for _, item := range items {
		if status != "" && item.Status != status {
			continue
		}
		if q != "" && !strings.Contains(strings.ToLower(item.Name+" "+item.Description), q) {
			continue
		}
		out = append(out, item)
	}
	return out
}

func sampleCanvas(workflowID string) models.WorkflowCanvas {
	approved := "approved"
	return models.WorkflowCanvas{
		WorkflowID: workflowID,
		Nodes: []models.WorkflowNode{
			{ID: "trigger", Label: "ERP Event Trigger", Type: "trigger", Icon: "mdi:flash-outline", Position: map[string]float64{"x": 70, "y": 72}, Status: models.StatusDone, Config: map[string]interface{}{"event": "erp.invoice.created"}},
			{ID: "classify", Label: "Classify Intent", Type: "action", Icon: "hugeicons:ai-magic", Position: map[string]float64{"x": 330, "y": 72}, Status: models.StatusDone, Config: map[string]interface{}{"model": "phi3:mini"}},
			{ID: "policy", Label: "Policy Guardrail", Type: "condition", Icon: "mdi:source-branch", Position: map[string]float64{"x": 595, "y": 72}, Status: models.StatusRunning, Config: map[string]interface{}{"requiresApproval": true}},
			{ID: "repair", Label: "Self-Heal Retry", Type: "healing", Icon: "mdi:shield-refresh-outline", Position: map[string]float64{"x": 595, "y": 245}, Status: models.StatusHealing, Config: map[string]interface{}{"retryBudget": 2}},
			{ID: "notify", Label: "Notify Owner", Type: "action", Icon: "mdi:bell-outline", Position: map[string]float64{"x": 850, "y": 72}, Status: models.StatusPending, Config: map[string]interface{}{"channel": "finance"}},
		},
		Edges: []models.WorkflowEdge{
			{ID: "edge-trigger-classify", Source: "trigger", Target: "classify", Type: "default"},
			{ID: "edge-classify-policy", Source: "classify", Target: "policy", Type: "default"},
			{ID: "edge-policy-notify", Source: "policy", Target: "notify", Type: "conditional", Label: &approved},
			{ID: "edge-policy-repair", Source: "policy", Target: "repair", Type: "conditional"},
		},
		Viewport: map[string]interface{}{"x": 0, "y": 0, "zoom": 1},
	}
}

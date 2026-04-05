package handlers

import (
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

func (h *Handler) DashboardSummary(c *fiber.Ctx) error {
	return c.JSON(models.OK(map[string]interface{}{
		"metrics": []map[string]interface{}{
			{"key": "activeWorkflows", "label": "Active Workflows", "value": 42, "formattedValue": "42", "delta": "+12.5%", "trend": "up", "icon": "tabler:git-branch", "tone": "primary"},
			{"key": "successfulRuns", "label": "Successful Runs", "value": 98.4, "formattedValue": "98.4%", "delta": "+2.1%", "trend": "up", "icon": "mdi:check-decagram-outline", "tone": "green"},
			{"key": "avgLatency", "label": "Avg Latency", "value": 1800, "formattedValue": "1.8s", "delta": "-320ms", "trend": "up", "icon": "mdi:timer-outline", "tone": "blue"},
			{"key": "healingWins", "label": "Healing Wins", "value": 17, "formattedValue": "17", "delta": "+5 today", "trend": "up", "icon": "mdi:shield-refresh-outline", "tone": "purple"},
		},
	}, "OK", map[string]interface{}{"range": c.Query("range", "7d"), "timezone": c.Query("timezone", "Asia/Colombo")}))
}

func (h *Handler) DashboardActivity(c *fiber.Ctx) error {
	now := time.Now().UTC()
	activity := []map[string]interface{}{
		{"id": "act_001", "title": "Procurement Risk Escalation entered self-healing", "description": "Connector token refresh was attempted automatically.", "type": "healing", "tone": "purple", "icon": "mdi:shield-refresh-outline", "createdAt": now.Add(-8 * time.Minute), "actor": models.Principal{ID: "system", Name: "Execution Engine"}, "resource": models.ResourceRef{Type: "workflow", ID: "wf-102"}},
		{"id": "act_002", "title": "ERP Invoice Exception Resolver completed 24 runs", "description": "Runs completed within the p95 enterprise latency target.", "type": "execution", "tone": "green", "icon": "mdi:check-decagram-outline", "createdAt": now.Add(-22 * time.Minute), "actor": models.Principal{ID: "usr_001", Name: "Lakshan Jay"}, "resource": models.ResourceRef{Type: "workflow", ID: "wf-101"}},
		{"id": "act_003", "title": "New MCP connector added for ERP sandbox", "description": "Connector metadata is ready for tool discovery.", "type": "integration", "tone": "blue", "icon": "mdi:connection", "createdAt": now.Add(-1 * time.Hour), "actor": models.Principal{ID: "usr_001", Name: "Lakshan Jay"}, "resource": models.ResourceRef{Type: "integration", ID: "int_erp_sandbox"}},
	}
	return c.JSON(models.OK(activity, "OK", map[string]interface{}{"nextCursor": nil}))
}

func (h *Handler) DashboardHealth(c *fiber.Ctx) error {
	now := time.Now().UTC()
	return c.JSON(models.OK(map[string]interface{}{
		"overall": "healthy",
		"services": []map[string]interface{}{
			{"name": "Synthesis API", "status": "healthy", "value": 96, "meta": "fallback-ready phi3:mini", "lastCheckedAt": now},
			{"name": "Execution Workers", "status": "healthy", "value": 94, "meta": "in-process runner", "lastCheckedAt": now},
			{"name": "MCP Bridge", "status": "degraded", "value": 88, "meta": "mock mode until MCP_BASE_URL is set", "lastCheckedAt": now},
			{"name": "Policy Gate", "status": "healthy", "value": 99, "meta": "schema + semantic checks", "lastCheckedAt": now},
		},
	}, "OK", nil))
}

func (h *Handler) RecentWorkflows(c *fiber.Ctx) error {
	limit := c.QueryInt("limit", 5)
	h.Store.Mu.RLock()
	items := repository.ListMapValues(h.Store.Workflows)
	h.Store.Mu.RUnlock()
	repository.SortWorkflows(items)
	if limit > 0 && limit < len(items) {
		items = items[:limit]
	}
	return c.JSON(models.OK(items, "OK", nil))
}

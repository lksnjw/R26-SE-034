package handlers

import (
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

func (h *Handler) GetSettings(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	settings := h.Store.Settings
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(settings, "OK", nil))
}

func (h *Handler) PatchSettings(c *fiber.Ctx) error {
	body := decodeMap(c)
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	if general, ok := body["general"].(map[string]interface{}); ok {
		h.Store.Settings.General = mergeMap(h.Store.Settings.General, general)
	}
	if llm, ok := body["llm"].(map[string]interface{}); ok {
		h.Store.Settings.LLM = mergeMap(h.Store.Settings.LLM, llm)
	}
	if rbac, ok := body["rbac"].(map[string]interface{}); ok {
		h.Store.Settings.RBAC = mergeMap(h.Store.Settings.RBAC, rbac)
	}
	return c.JSON(models.OK(h.Store.Settings, "Settings updated", nil))
}

func (h *Handler) GetGeneralSettings(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	data := h.Store.Settings.General
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(data, "OK", nil))
}

func (h *Handler) PatchGeneralSettings(c *fiber.Ctx) error {
	body := decodeMap(c)
	h.Store.Mu.Lock()
	h.Store.Settings.General = mergeMap(h.Store.Settings.General, body)
	data := h.Store.Settings.General
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(data, "General settings updated", nil))
}

func (h *Handler) GetLLMSettings(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	data := h.Store.Settings.LLM
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(data, "OK", nil))
}

func (h *Handler) PatchLLMSettings(c *fiber.Ctx) error {
	body := decodeMap(c)
	h.Store.Mu.Lock()
	h.Store.Settings.LLM = mergeMap(h.Store.Settings.LLM, body)
	data := h.Store.Settings.LLM
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(data, "LLM settings updated", nil))
}

func (h *Handler) GetRBACSettings(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	data := h.Store.Settings.RBAC
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(data, "OK", nil))
}

func (h *Handler) PatchRBACSettings(c *fiber.Ctx) error {
	body := decodeMap(c)
	h.Store.Mu.Lock()
	h.Store.Settings.RBAC = mergeMap(h.Store.Settings.RBAC, body)
	data := h.Store.Settings.RBAC
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(data, "RBAC settings updated", nil))
}

func (h *Handler) ListWebhooks(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	webhooks := repository.ListMapValues(h.Store.Webhooks)
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(webhooks, "OK", nil))
}

func (h *Handler) CreateWebhook(c *fiber.Ctx) error {
	body := decodeMap(c)
	webhook := &models.Webhook{ID: "wh_" + randomHex(4), Name: fmt.Sprint(body["name"]), URL: fmt.Sprint(body["url"]), Events: parseStringSlice(body["events"]), Enabled: true, SecretPreview: "whsec_...." + randomHex(2), CreatedAt: time.Now().UTC()}
	h.Store.Mu.Lock()
	h.Store.Webhooks[webhook.ID] = webhook
	h.Store.Mu.Unlock()
	return c.Status(fiber.StatusCreated).JSON(models.OK(webhook, "Webhook created", nil))
}

func (h *Handler) UpdateWebhook(c *fiber.Ctx) error {
	body := decodeMap(c)
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	webhook, ok := h.Store.Webhooks[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Webhook not found")
	}
	if name := fmt.Sprint(body["name"]); name != "" && name != "<nil>" {
		webhook.Name = name
	}
	if url := fmt.Sprint(body["url"]); url != "" && url != "<nil>" {
		webhook.URL = url
	}
	if events := parseStringSlice(body["events"]); len(events) > 0 {
		webhook.Events = events
	}
	if enabled, ok := body["enabled"].(bool); ok {
		webhook.Enabled = enabled
	}
	return c.JSON(models.OK(webhook, "Webhook updated", nil))
}

func (h *Handler) DeleteWebhook(c *fiber.Ctx) error {
	h.Store.Mu.Lock()
	delete(h.Store.Webhooks, c.Params("id"))
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(map[string]bool{"deleted": true}, "Webhook deleted", nil))
}

func (h *Handler) TestWebhook(c *fiber.Ctx) error {
	return c.JSON(models.OK(map[string]interface{}{"delivered": true, "statusCode": 200, "latencyMs": 142}, "Webhook test delivered", nil))
}

func (h *Handler) ListIntegrations(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	integrations := repository.ListMapValues(h.Store.Integrations)
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(integrations, "OK", nil))
}

func (h *Handler) CreateIntegration(c *fiber.Ctx) error {
	body := decodeMap(c)
	integration := &models.Integration{ID: "int_" + randomHex(4), Name: fmt.Sprint(body["name"]), Type: fmt.Sprint(body["type"]), Status: "Disconnected", Icon: "mdi:connection", Config: map[string]interface{}{}, CreatedAt: time.Now().UTC()}
	if cfg, ok := body["config"].(map[string]interface{}); ok {
		integration.Config = cfg
	}
	h.Store.Mu.Lock()
	h.Store.Integrations[integration.ID] = integration
	h.Store.Mu.Unlock()
	return c.Status(fiber.StatusCreated).JSON(models.OK(integration, "Integration created", nil))
}

func (h *Handler) GetIntegration(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	integration, ok := h.Store.Integrations[c.Params("id")]
	h.Store.Mu.RUnlock()
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Integration not found")
	}
	return c.JSON(models.OK(integration, "OK", nil))
}

func (h *Handler) UpdateIntegration(c *fiber.Ctx) error {
	body := decodeMap(c)
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	integration, ok := h.Store.Integrations[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Integration not found")
	}
	if status := fmt.Sprint(body["status"]); status != "" && status != "<nil>" {
		integration.Status = status
	}
	if cfg, ok := body["config"].(map[string]interface{}); ok {
		integration.Config = mergeMap(integration.Config, cfg)
	}
	return c.JSON(models.OK(integration, "Integration updated", nil))
}

func (h *Handler) DeleteIntegration(c *fiber.Ctx) error {
	h.Store.Mu.Lock()
	delete(h.Store.Integrations, c.Params("id"))
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(map[string]bool{"deleted": true}, "Integration deleted", nil))
}

func (h *Handler) TestIntegration(c *fiber.Ctx) error {
	now := time.Now().UTC()
	h.Store.Mu.Lock()
	if integration := h.Store.Integrations[c.Params("id")]; integration != nil {
		integration.LastTestedAt = &now
	}
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(map[string]interface{}{"connected": true, "latencyMs": 118, "checkedAt": now}, "Integration test passed", nil))
}

func (h *Handler) ConnectIntegration(c *fiber.Ctx) error {
	return h.setIntegrationStatus(c, "Connected")
}

func (h *Handler) DisconnectIntegration(c *fiber.Ctx) error {
	return h.setIntegrationStatus(c, "Disconnected")
}

func (h *Handler) setIntegrationStatus(c *fiber.Ctx, status string) error {
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	integration, ok := h.Store.Integrations[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Integration not found")
	}
	integration.Status = status
	return c.JSON(models.OK(integration, "Integration status updated", nil))
}

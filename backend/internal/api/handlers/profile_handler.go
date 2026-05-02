package handlers

import (
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
)

func (h *Handler) GetProfile(c *fiber.Ctx) error {
	user := h.currentUser(c)
	profile := models.Profile{ID: user.ID, Name: user.Name, Email: user.Email, Role: user.Role.Name, Timezone: "Asia/Colombo", AvatarURL: nil, TwoFactorEnabled: user.TwoFactorEnabled}
	return c.JSON(models.OK(profile, "OK", nil))
}

func (h *Handler) UpdateProfile(c *fiber.Ctx) error {
	body := decodeMap(c)
	h.Store.Mu.Lock()
	user := h.Store.Users[h.currentUserID(c)]
	if name := fmt.Sprint(body["name"]); name != "" && name != "<nil>" {
		user.Name = name
		user.Initials = initials(name)
	}
	h.Store.Mu.Unlock()
	return h.GetProfile(c)
}

func (h *Handler) UpdateSecurity(c *fiber.Ctx) error {
	body := decodeMap(c)
	enabled, _ := body["twoFactorEnabled"].(bool)
	h.Store.Mu.Lock()
	user := h.Store.Users[h.currentUserID(c)]
	user.TwoFactorEnabled = enabled
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(map[string]interface{}{"twoFactorEnabled": enabled, "requireApprovalBeforeProductionRuns": body["requireApprovalBeforeProductionRuns"]}, "Security settings updated", nil))
}

func (h *Handler) GetNotificationPreferences(c *fiber.Ctx) error {
	return c.JSON(models.OK(defaultNotificationPreferences(), "OK", nil))
}

func (h *Handler) UpdateNotificationPreferences(c *fiber.Ctx) error {
	body := decodeMap(c)
	return c.JSON(models.OK(mergeMap(map[string]interface{}{}, body), "Notification preferences updated", nil))
}

func (h *Handler) ListAPIKeys(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	keys := repository.ListMapValues(h.Store.APIKeys)
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(keys, "OK", nil))
}

func (h *Handler) CreateAPIKey(c *fiber.Ctx) error {
	body := decodeMap(c)
	key := "wf_live_" + randomHex(24)
	apiKey := &models.APIKey{ID: "key_" + randomHex(4), Name: fmt.Sprint(body["name"]), Key: key, MaskedKey: "wf_live_................" + key[len(key)-4:], Scopes: parseStringSlice(body["scopes"]), CreatedAt: time.Now().UTC()}
	h.Store.Mu.Lock()
	h.Store.APIKeys[apiKey.ID] = apiKey
	h.Store.Mu.Unlock()
	return c.Status(fiber.StatusCreated).JSON(models.OK(apiKey, "API key created. Store the key now; it will not be shown again.", nil))
}

func (h *Handler) DeleteAPIKey(c *fiber.Ctx) error {
	h.Store.Mu.Lock()
	delete(h.Store.APIKeys, c.Params("id"))
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(map[string]bool{"revoked": true}, "API key revoked", nil))
}

func defaultNotificationPreferences() models.NotificationPreferences {
	return models.NotificationPreferences{
		ExecutionFailures: true,
		HealingEvents:     true,
		BudgetWarnings:    true,
		WeeklyReports:     false,
		Channels:          map[string]bool{"inApp": true, "email": true, "webhook": false},
	}
}

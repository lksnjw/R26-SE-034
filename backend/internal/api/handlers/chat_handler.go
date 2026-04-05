package handlers

import (
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
)

func (h *Handler) Synthesize(c *fiber.Ctx) error {
	body := decodeMap(c)
	prompt, _ := body["prompt"].(string)
	if prompt == "" {
		return fiber.NewError(fiber.StatusBadRequest, "prompt is required")
	}
	mode, _ := body["mode"].(string)
	model, _ := body["model"].(string)
	contextMap, _ := body["context"].(map[string]interface{})

	result, err := h.Synth.Synthesize(c.Context(), prompt, mode, model, contextMap)
	if err != nil {
		return fiber.NewError(fiber.StatusBadGateway, err.Error())
	}
	validation, blueprint := h.Validator.ValidateYAML(result.YAML, h.permissions(c))

	response := map[string]interface{}{
		"yaml":       result.YAML,
		"confidence": result.Confidence,
		"workflowDraft": map[string]interface{}{
			"name":    blueprint.Name,
			"steps":   len(blueprint.Steps),
			"trigger": blueprint.Trigger.Type,
		},
		"validation":  validation,
		"flowPreview": previewCanvas("draft", blueprint),
		"usage":       result.Usage,
	}

	return c.JSON(models.OK(response, "Workflow draft generated", nil))
}

func (h *Handler) SynthesisValidate(c *fiber.Ctx) error {
	body := decodeMap(c)
	yamlText, _ := body["yaml"].(string)
	validation, _ := h.Validator.ValidateYAML(yamlText, h.permissions(c))
	return c.JSON(models.OK(validation, validationMessage(validation), nil))
}

func (h *Handler) SynthesisPreviewFlow(c *fiber.Ctx) error {
	body := decodeMap(c)
	yamlText, _ := body["yaml"].(string)
	validation, blueprint := h.Validator.ValidateYAML(yamlText, h.permissions(c))
	if !validation.Valid {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Cannot preview invalid YAML", validation))
	}
	return c.JSON(models.OK(previewCanvas("preview", blueprint), "Flow preview generated", nil))
}

func (h *Handler) SynthesisExplain(c *fiber.Ctx) error {
	body := decodeMap(c)
	yamlText, _ := body["yaml"].(string)
	validation, blueprint := h.Validator.ValidateYAML(yamlText, h.permissions(c))
	if !validation.Valid {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Cannot explain invalid YAML", validation))
	}
	steps := make([]map[string]interface{}, 0, len(blueprint.Steps))
	for _, step := range blueprint.Steps {
		steps = append(steps, map[string]interface{}{"id": step.ID, "action": step.Action, "purpose": "Executes through the tool registry and MCP bridge."})
	}
	return c.JSON(models.OK(map[string]interface{}{"summary": "This workflow starts from " + blueprint.Trigger.Type + " and executes each validated MCP-safe step sequentially.", "steps": steps}, "Explanation generated", nil))
}

func (h *Handler) ListChatSessions(c *fiber.Ctx) error {
	page, limit := pageLimit(c)
	h.Store.Mu.RLock()
	sessions := make([]models.ChatSession, 0, len(h.Store.Chats))
	for _, session := range h.Store.Chats {
		sessions = append(sessions, session.ChatSession)
	}
	h.Store.Mu.RUnlock()
	paged, meta := paginate(sessions, page, limit)
	return c.JSON(models.OK(paged, "OK", meta))
}

func (h *Handler) CreateChatSession(c *fiber.Ctx) error {
	body := decodeMap(c)
	title := fmt.Sprint(body["title"])
	if title == "" || title == "<nil>" {
		title = "New workflow conversation"
	}
	now := time.Now().UTC()
	session := &models.ChatSessionDetail{ChatSession: models.ChatSession{ID: "chat_" + randomHex(4), Title: title, CreatedAt: now, UpdatedAt: now, MessageCount: 0}, Messages: []models.ChatMessage{}}
	h.Store.Mu.Lock()
	h.Store.Chats[session.ID] = session
	h.Store.Mu.Unlock()
	return c.Status(fiber.StatusCreated).JSON(models.OK(session.ChatSession, "Chat session created", nil))
}

func (h *Handler) GetChatSession(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	session, ok := h.Store.Chats[c.Params("id")]
	h.Store.Mu.RUnlock()
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Chat session not found")
	}
	return c.JSON(models.OK(session, "OK", nil))
}

func (h *Handler) UpdateChatSession(c *fiber.Ctx) error {
	body := decodeMap(c)
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	session, ok := h.Store.Chats[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Chat session not found")
	}
	if title := fmt.Sprint(body["title"]); title != "" && title != "<nil>" {
		session.Title = title
	}
	session.UpdatedAt = time.Now().UTC()
	return c.JSON(models.OK(session.ChatSession, "Chat session updated", nil))
}

func (h *Handler) DeleteChatSession(c *fiber.Ctx) error {
	h.Store.Mu.Lock()
	delete(h.Store.Chats, c.Params("id"))
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(map[string]bool{"deleted": true}, "Chat session deleted", nil))
}

func (h *Handler) SendChatMessage(c *fiber.Ctx) error {
	body := decodeMap(c)
	message := fmt.Sprint(body["message"])
	if message == "" || message == "<nil>" {
		return fiber.NewError(fiber.StatusBadRequest, "message is required")
	}
	model, _ := body["model"].(string)
	mode, _ := body["mode"].(string)
	result, _ := h.Synth.Synthesize(c.Context(), message, mode, model, map[string]interface{}{"workflowId": body["workflowId"]})
	validation, blueprint := h.Validator.ValidateYAML(result.YAML, h.permissions(c))
	canvas := previewCanvas("chat-preview", blueprint)

	now := time.Now().UTC()
	userMessage := models.ChatMessage{ID: "msg_" + randomHex(4), Role: "user", Text: message, CreatedAt: now}
	assistantMessage := models.ChatMessage{ID: "msg_" + randomHex(4), Role: "assistant", Text: "I generated a validated YAML workflow draft and updated the flow preview.", CreatedAt: now.Add(2 * time.Second)}

	h.Store.Mu.Lock()
	session, ok := h.Store.Chats[c.Params("id")]
	if !ok {
		session = &models.ChatSessionDetail{ChatSession: models.ChatSession{ID: c.Params("id"), Title: "Workflow conversation", CreatedAt: now}, Messages: []models.ChatMessage{}}
		h.Store.Chats[session.ID] = session
	}
	session.Messages = append(session.Messages, userMessage, assistantMessage)
	session.MessageCount = len(session.Messages)
	session.UpdatedAt = now
	h.Store.Mu.Unlock()

	return c.JSON(models.OK(map[string]interface{}{
		"userMessage":      userMessage,
		"assistantMessage": assistantMessage,
		"artifacts": map[string]interface{}{
			"yaml":        result.YAML,
			"flowPreview": canvas,
			"validation":  validation,
		},
	}, "Message processed", nil))
}

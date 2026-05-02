package handlers

import (
	"fmt"
	"mime/multipart"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"github.com/sanjeewa/agentic-orchestrator/pkg/parser"
)

func (h *Handler) ListNotifications(c *fiber.Ctx) error {
	page, limit := pageLimit(c)
	unreadOnly := c.QueryBool("unreadOnly", false)
	h.Store.Mu.RLock()
	all := repository.ListMapValues(h.Store.Notifications)
	h.Store.Mu.RUnlock()
	items := []models.Notification{}
	for _, notification := range all {
		if unreadOnly && notification.Read {
			continue
		}
		items = append(items, notification)
	}
	paged, meta := paginate(items, page, limit)
	return c.JSON(models.OK(paged, "OK", meta))
}

func (h *Handler) MarkNotificationRead(c *fiber.Ctx) error {
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	notification, ok := h.Store.Notifications[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Notification not found")
	}
	notification.Read = true
	return c.JSON(models.OK(notification, "Notification marked read", nil))
}

func (h *Handler) MarkAllNotificationsRead(c *fiber.Ctx) error {
	h.Store.Mu.Lock()
	for _, notification := range h.Store.Notifications {
		notification.Read = true
	}
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(map[string]bool{"updated": true}, "All notifications marked read", nil))
}

func (h *Handler) DeleteNotification(c *fiber.Ctx) error {
	h.Store.Mu.Lock()
	delete(h.Store.Notifications, c.Params("id"))
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(map[string]bool{"deleted": true}, "Notification deleted", nil))
}

func (h *Handler) Upload(c *fiber.Ctx) error {
	file, err := c.FormFile("file")
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "file is required")
	}
	uploaded := uploadedFromFile(file)
	h.Store.Mu.Lock()
	h.Store.Uploads[uploaded.ID] = &uploaded
	h.Store.Mu.Unlock()
	return c.Status(fiber.StatusCreated).JSON(models.OK(uploaded, "Upload complete", nil))
}

func (h *Handler) GetUpload(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	file, ok := h.Store.Uploads[c.Params("id")]
	h.Store.Mu.RUnlock()
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Upload not found")
	}
	return c.JSON(models.OK(file, "OK", nil))
}

func (h *Handler) DeleteUpload(c *fiber.Ctx) error {
	h.Store.Mu.Lock()
	delete(h.Store.Uploads, c.Params("id"))
	h.Store.Mu.Unlock()
	return c.JSON(models.OK(map[string]bool{"deleted": true}, "Upload deleted", nil))
}

func (h *Handler) ImportWorkflow(c *fiber.Ctx) error {
	yamlText := c.FormValue("yaml")
	if yamlText == "" {
		body := decodeMap(c)
		yamlText, _ = body["yaml"].(string)
	}
	if yamlText == "" {
		yamlText = "name: imported_workflow\ntrigger:\n  type: file.uploaded\nsteps:\n  - id: policy\n    action: policy_check\n"
	}

	validation, blueprint := h.Validator.ValidateYAML(yamlText, h.permissions(c))
	now := time.Now().UTC()
	id := "wf-" + randomHex(4)
	workflow := &models.Workflow{ID: id, Name: blueprint.Name, Description: "Imported workflow", Owner: principalFromUser(h.currentUser(c)), Status: models.StatusPending, Trigger: map[string]interface{}{"type": blueprint.Trigger.Type, "displayName": blueprint.Trigger.DisplayName}, Steps: len(blueprint.Steps), DraftVersion: 1, YAML: yamlText, Canvas: previewCanvas(id, blueprint), CreatedAt: now, UpdatedAt: now}
	if workflow.Name == "" {
		workflow.Name = "Imported Workflow"
	}
	if validation.Valid {
		h.Store.Mu.Lock()
		h.Store.Workflows[id] = workflow
		h.Store.Mu.Unlock()
	}

	return c.JSON(models.OK(map[string]interface{}{"workflow": map[string]interface{}{"id": workflow.ID, "name": workflow.Name, "status": workflow.Status}, "validation": validation}, "Workflow imported", nil))
}

func uploadedFromFile(file *multipart.FileHeader) models.UploadedFile {
	id := "file_" + randomHex(4)
	return models.UploadedFile{
		ID:        id,
		Name:      file.Filename,
		MimeType:  file.Header.Get("Content-Type"),
		SizeBytes: file.Size,
		URL:       "/api/upload/" + id + "/download",
		Checksum:  parser.Checksum(fmt.Sprintf("%s:%d", file.Filename, file.Size)),
		CreatedAt: time.Now().UTC(),
	}
}

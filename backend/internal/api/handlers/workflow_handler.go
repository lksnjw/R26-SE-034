package handlers

import (
	"fmt"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/repository"
	"github.com/sanjeewa/agentic-orchestrator/pkg/parser"
)

func (h *Handler) ListWorkflows(c *fiber.Ctx) error {
	page, limit := pageLimit(c)
	h.Store.Mu.RLock()
	items := repository.ListMapValues(h.Store.Workflows)
	h.Store.Mu.RUnlock()

	items = repository.FilterWorkflows(items, c.Query("q"), c.Query("status"))
	repository.SortWorkflows(items)
	paged, meta := paginate(items, page, limit)
	meta.Sort = c.Query("sort", "-updatedAt")
	return c.JSON(models.OK(paged, "OK", meta))
}

func (h *Handler) CreateWorkflow(c *fiber.Ctx) error {
	var req models.CreateWorkflowRequest
	if err := h.parseBody(c, &req); err != nil {
		return err
	}
	actor := principalFromUser(h.currentUser(c))

	if req.YAML == "" {
		req.YAML = fmt.Sprintf("name: %s\ntrigger:\n  type: user.created\nsteps:\n  - id: start\n    action: policy_check\n", req.Name)
	}
	validation, blueprint := h.Validator.ValidateYAML(req.YAML, h.permissions(c))
	if !validation.Valid {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Workflow YAML failed validation", validation))
	}

	now := time.Now().UTC()
	id := "wf-" + randomHex(4)
	workflow := &models.Workflow{
		ID: id, Name: req.Name, Description: req.Description,
		Owner: models.Principal{ID: req.OwnerID, Name: req.OwnerID}, Status: models.StatusPending,
		Trigger: req.Trigger, Steps: len(blueprint.Steps), SuccessRate: 0, PublishedVersion: 0, DraftVersion: 1,
		Tags: req.Tags, YAML: req.YAML, Canvas: previewCanvas(id, blueprint), CreatedAt: now, UpdatedAt: now,
	}
	if workflow.Owner.ID == "" {
		user := h.currentUser(c)
		workflow.Owner = principalFromUser(user)
	}
	if workflow.Trigger == nil {
		workflow.Trigger = map[string]interface{}{"type": blueprint.Trigger.Type, "displayName": blueprint.Trigger.DisplayName, "config": blueprint.Trigger.Config}
	}

	h.Store.Mu.Lock()
	h.Store.Workflows[id] = workflow
	h.Store.Audit(actor, "workflow.created", models.ResourceRef{Type: "workflow", ID: id}, nil, map[string]interface{}{"name": workflow.Name}, c.IP(), c.Get("User-Agent"))
	h.Store.Mu.Unlock()

	return c.Status(fiber.StatusCreated).JSON(models.OK(workflow, "Workflow created", nil))
}

func (h *Handler) GetWorkflow(c *fiber.Ctx) error {
	workflow, ok := h.workflowByID(c.Params("id"))
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	return c.JSON(models.OK(workflow, "OK", nil))
}

func (h *Handler) UpdateWorkflow(c *fiber.Ctx) error {
	var req models.UpdateWorkflowRequest
	if err := h.parseBody(c, &req); err != nil {
		return err
	}
	actor := principalFromUser(h.currentUser(c))

	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	workflow, ok := h.Store.Workflows[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	before := map[string]interface{}{"name": workflow.Name, "status": workflow.Status}
	if req.Name != nil {
		workflow.Name = *req.Name
	}
	if req.Description != nil {
		workflow.Description = *req.Description
	}
	if req.Status != nil {
		workflow.Status = *req.Status
	}
	if req.Trigger != nil {
		workflow.Trigger = req.Trigger
	}
	if req.Tags != nil {
		workflow.Tags = req.Tags
	}
	workflow.UpdatedAt = time.Now().UTC()
	h.Store.Audit(actor, "workflow.updated", models.ResourceRef{Type: "workflow", ID: workflow.ID}, before, map[string]interface{}{"name": workflow.Name, "status": workflow.Status}, c.IP(), c.Get("User-Agent"))
	return c.JSON(models.OK(workflow, "Workflow updated", nil))
}

func (h *Handler) DeleteWorkflow(c *fiber.Ctx) error {
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	if _, ok := h.Store.Workflows[c.Params("id")]; !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	delete(h.Store.Workflows, c.Params("id"))
	return c.JSON(models.OK(map[string]bool{"deleted": true}, "Workflow deleted", nil))
}

func (h *Handler) DuplicateWorkflow(c *fiber.Ctx) error {
	body := decodeMap(c)
	source, ok := h.workflowByID(c.Params("id"))
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}

	clone := *source
	clone.ID = "wf-" + randomHex(4)
	clone.Name = fmt.Sprint(body["name"])
	if clone.Name == "" || clone.Name == "<nil>" {
		clone.Name = source.Name + " Copy"
	}
	clone.Status = models.StatusPending
	clone.CreatedAt = time.Now().UTC()
	clone.UpdatedAt = clone.CreatedAt
	clone.Canvas.WorkflowID = clone.ID

	h.Store.Mu.Lock()
	h.Store.Workflows[clone.ID] = &clone
	h.Store.Mu.Unlock()
	return c.Status(fiber.StatusCreated).JSON(models.OK(clone, "Workflow duplicated", nil))
}

func (h *Handler) PublishWorkflow(c *fiber.Ctx) error {
	body := decodeMap(c)
	actor := principalFromUser(h.currentUser(c))
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	workflow, ok := h.Store.Workflows[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	workflow.PublishedVersion = workflow.DraftVersion
	version := models.WorkflowVersion{
		ID: "ver_" + randomHex(4), WorkflowID: workflow.ID, Version: workflow.PublishedVersion,
		VersionNote: fmt.Sprint(body["versionNote"]), YAML: workflow.YAML, CreatedAt: time.Now().UTC(), CreatedBy: actor,
	}
	h.Store.Versions[workflow.ID] = append(h.Store.Versions[workflow.ID], version)
	return c.JSON(models.OK(version, "Workflow published", nil))
}

func (h *Handler) ArchiveWorkflow(c *fiber.Ctx) error {
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	workflow, ok := h.Store.Workflows[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	workflow.Archived = true
	workflow.Status = models.StatusDone
	return c.JSON(models.OK(map[string]bool{"archived": true}, "Workflow archived", nil))
}

func (h *Handler) ValidateWorkflow(c *fiber.Ctx) error {
	workflow, ok := h.workflowByID(c.Params("id"))
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	body := decodeMap(c)
	yamlText, _ := body["yaml"].(string)
	if yamlText == "" {
		yamlText = workflow.YAML
	}
	validation, _ := h.Validator.ValidateYAML(yamlText, h.permissions(c))
	return c.JSON(models.OK(validation, validationMessage(validation), nil))
}

func (h *Handler) GetWorkflowYAML(c *fiber.Ctx) error {
	workflow, ok := h.workflowByID(c.Params("id"))
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	return c.JSON(models.OK(models.WorkflowYAML{WorkflowID: workflow.ID, Version: workflow.DraftVersion, YAML: workflow.YAML, Checksum: parser.Checksum(workflow.YAML), UpdatedAt: workflow.UpdatedAt}, "OK", nil))
}

func (h *Handler) PutWorkflowYAML(c *fiber.Ctx) error {
	var req models.WorkflowYAML
	if err := h.parseBody(c, &req); err != nil {
		return err
	}
	validation, blueprint := h.Validator.ValidateYAML(req.YAML, h.permissions(c))
	if !validation.Valid {
		return c.Status(fiber.StatusUnprocessableEntity).JSON(models.Fail("Workflow YAML failed validation", validation))
	}

	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	workflow, ok := h.Store.Workflows[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	workflow.YAML = req.YAML
	workflow.DraftVersion++
	workflow.Steps = len(blueprint.Steps)
	workflow.Canvas = previewCanvas(workflow.ID, blueprint)
	workflow.UpdatedAt = time.Now().UTC()
	return c.JSON(models.OK(models.WorkflowYAML{WorkflowID: workflow.ID, Version: workflow.DraftVersion, YAML: workflow.YAML, Checksum: parser.Checksum(workflow.YAML), UpdatedAt: workflow.UpdatedAt}, "Workflow YAML updated", nil))
}

func (h *Handler) GetWorkflowCanvas(c *fiber.Ctx) error {
	workflow, ok := h.workflowByID(c.Params("id"))
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	return c.JSON(models.OK(workflow.Canvas, "OK", nil))
}

func (h *Handler) PutWorkflowCanvas(c *fiber.Ctx) error {
	var canvas models.WorkflowCanvas
	if err := h.parseBody(c, &canvas); err != nil {
		return err
	}
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	workflow, ok := h.Store.Workflows[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	canvas.WorkflowID = workflow.ID
	workflow.Canvas = canvas
	workflow.UpdatedAt = time.Now().UTC()
	return c.JSON(models.OK(canvas, "Workflow canvas updated", nil))
}

func (h *Handler) WorkflowVersions(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	versions := append([]models.WorkflowVersion{}, h.Store.Versions[c.Params("id")]...)
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(versions, "OK", nil))
}

func (h *Handler) RestoreWorkflowVersion(c *fiber.Ctx) error {
	h.Store.Mu.Lock()
	defer h.Store.Mu.Unlock()
	workflow, ok := h.Store.Workflows[c.Params("id")]
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Workflow not found")
	}
	for _, version := range h.Store.Versions[workflow.ID] {
		if version.ID == c.Params("versionId") {
			workflow.YAML = version.YAML
			workflow.DraftVersion++
			workflow.UpdatedAt = time.Now().UTC()
			return c.JSON(models.OK(workflow, "Workflow restored", nil))
		}
	}
	return fiber.NewError(fiber.StatusNotFound, "Workflow version not found")
}

func (h *Handler) ListTemplates(c *fiber.Ctx) error {
	h.Store.Mu.RLock()
	templates := repository.ListMapValues(h.Store.Templates)
	h.Store.Mu.RUnlock()
	return c.JSON(models.OK(templates, "OK", nil))
}

func (h *Handler) CreateTemplate(c *fiber.Ctx) error {
	body := decodeMap(c)
	template := &models.WorkflowTemplate{
		ID: "tpl_" + randomHex(4), Name: fmt.Sprint(body["name"]), Description: fmt.Sprint(body["description"]),
		Category: fmt.Sprint(body["category"]), Tags: parseStringSlice(body["tags"]), YAML: fmt.Sprint(body["yaml"]),
		Steps: toInt(body["steps"], 1), CreatedAt: time.Now().UTC(),
	}
	h.Store.Mu.Lock()
	h.Store.Templates[template.ID] = template
	h.Store.Mu.Unlock()
	return c.Status(fiber.StatusCreated).JSON(models.OK(template, "Template created", nil))
}

func (h *Handler) UseTemplate(c *fiber.Ctx) error {
	body := decodeMap(c)
	h.Store.Mu.RLock()
	template, ok := h.Store.Templates[c.Params("id")]
	h.Store.Mu.RUnlock()
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Template not found")
	}
	name := fmt.Sprint(body["name"])
	if name == "" || name == "<nil>" {
		name = template.Name
	}
	req := models.CreateWorkflowRequest{Name: name, Description: template.Description, YAML: template.YAML, Tags: template.Tags}
	now := time.Now().UTC()
	id := "wf-" + randomHex(4)
	validation, blueprint := h.Validator.ValidateYAML(template.YAML, h.permissions(c))
	canvas := models.WorkflowCanvas{WorkflowID: id, Nodes: []models.WorkflowNode{}, Edges: []models.WorkflowEdge{}, Viewport: map[string]interface{}{"x": 0, "y": 0, "zoom": 1}}
	if validation.Valid {
		canvas = previewCanvas(id, blueprint)
	}
	workflow := &models.Workflow{ID: id, Name: req.Name, Description: req.Description, Owner: principalFromUser(h.currentUser(c)), Status: models.StatusPending, Trigger: map[string]interface{}{"type": "template.used", "displayName": template.Name}, Steps: template.Steps, SuccessRate: 0, DraftVersion: 1, Tags: req.Tags, YAML: req.YAML, Canvas: canvas, CreatedAt: now, UpdatedAt: now}
	workflow.Canvas.WorkflowID = id
	h.Store.Mu.Lock()
	h.Store.Workflows[id] = workflow
	h.Store.Mu.Unlock()
	return c.Status(fiber.StatusCreated).JSON(models.OK(workflow, "Template converted to workflow", nil))
}

func (h *Handler) workflowByID(id string) (*models.Workflow, bool) {
	h.Store.Mu.RLock()
	defer h.Store.Mu.RUnlock()
	workflow, ok := h.Store.Workflows[id]
	return workflow, ok
}

func validationMessage(result models.ValidationResult) string {
	if result.Valid {
		return "Workflow is valid"
	}
	return "Workflow is invalid"
}

func previewCanvas(workflowID string, blueprint models.WorkflowBlueprint) models.WorkflowCanvas {
	nodes := make([]models.WorkflowNode, 0, len(blueprint.Steps)+1)
	edges := []models.WorkflowEdge{}
	nodes = append(nodes, models.WorkflowNode{ID: "trigger", Label: blueprint.Trigger.DisplayName, Type: "trigger", Position: map[string]float64{"x": 70, "y": 72}, Status: models.StatusPending, Config: blueprint.Trigger.Config})
	prev := "trigger"
	for index, step := range blueprint.Steps {
		id := step.ID
		nodes = append(nodes, models.WorkflowNode{ID: id, Label: step.Action, Type: "action", Position: map[string]float64{"x": float64(330 + index*260), "y": 72}, Status: models.StatusPending, Config: step.Parameters})
		edges = append(edges, models.WorkflowEdge{ID: "edge-" + prev + "-" + id, Source: prev, Target: id, Type: "default"})
		prev = id
	}
	return models.WorkflowCanvas{WorkflowID: workflowID, Nodes: nodes, Edges: edges, Viewport: map[string]interface{}{"x": 0, "y": 0, "zoom": 1}}
}

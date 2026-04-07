package runner

import (
	"context"
	"fmt"
	"time"

	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/internal/tools"
	"go.uber.org/zap"
)

type Executor struct {
	Registry *tools.Registry
	Log      *zap.Logger
}

type Result struct {
	Logs     []models.ExecutionLog  `json:"logs"`
	Timeline []models.ExecutionStep `json:"timeline"`
	State    map[string]interface{} `json:"state"`
}

func NewExecutor(registry *tools.Registry, log *zap.Logger) *Executor {
	return &Executor{Registry: registry, Log: log}
}

func (e *Executor) Run(ctx context.Context, executionID string, workflow models.Workflow, blueprint models.WorkflowBlueprint, input map[string]interface{}) (Result, error) {
	started := time.Now().UTC()
	manager := NewStateManager(models.RunnerState{
		WorkflowID:  workflow.ID,
		ExecutionID: executionID,
		Variables: map[string]interface{}{
			"input": input,
		},
		StartedAt: started,
	})

	result := Result{
		Logs:     []models.ExecutionLog{},
		Timeline: []models.ExecutionStep{},
		State:    manager.Snapshot(),
	}

	for index, step := range blueprint.Steps {
		stepStart := time.Now().UTC()
		nodeID := step.ID
		timelineStep := models.ExecutionStep{
			ID:        fmt.Sprintf("step_%03d", index+1),
			NodeID:    nodeID,
			Label:     labelForStep(step),
			Status:    models.StatusRunning,
			StartedAt: stepStart,
		}

		params := manager.Resolve(step.Parameters)
		params["_action"] = step.Action

		tool, err := e.Registry.Get(step.Action)
		if err != nil {
			return result, err
		}

		toolResult, err := tool.Execute(ctx, params)
		completed := time.Now().UTC()
		duration := completed.Sub(stepStart).Milliseconds()
		timelineStep.CompletedAt = &completed
		timelineStep.DurationMS = &duration

		if err != nil {
			timelineStep.Status = models.StatusFailed
			result.Timeline = append(result.Timeline, timelineStep)
			result.Logs = append(result.Logs, models.ExecutionLog{
				ID: executionID + fmt.Sprintf("_log_%03d", index+1), ExecutionID: executionID, Timestamp: completed,
				Level: "error", NodeID: nodeID, Message: err.Error(), Metadata: map[string]interface{}{"action": step.Action},
			})
			return result, fmt.Errorf("step %s failed: %w", step.ID, err)
		}

		manager.Save(step.ID, toolResult)
		timelineStep.Status = models.StatusDone
		result.Timeline = append(result.Timeline, timelineStep)
		result.Logs = append(result.Logs, models.ExecutionLog{
			ID: executionID + fmt.Sprintf("_log_%03d", index+1), ExecutionID: executionID, Timestamp: completed,
			Level: "info", NodeID: nodeID, Message: fmt.Sprintf("%s executed through tool registry", step.Action), Metadata: toolResult,
		})
	}

	result.State = manager.Snapshot()
	return result, nil
}

func labelForStep(step models.WorkflowStepBlueprint) string {
	if step.Description != "" {
		return step.Description
	}
	if step.Type != "" {
		return step.Type + ": " + step.Action
	}
	return step.Action
}

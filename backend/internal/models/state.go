package models

import "time"

type RunnerState struct {
	WorkflowID  string                 `json:"workflowId"`
	ExecutionID string                 `json:"executionId"`
	Variables   map[string]interface{} `json:"variables"`
	StartedAt   time.Time              `json:"startedAt"`
}

type Execution struct {
	ID           string     `json:"id"`
	WorkflowID   string     `json:"workflowId"`
	WorkflowName string     `json:"workflowName"`
	Status       string     `json:"status"`
	StartedAt    time.Time  `json:"startedAt"`
	CompletedAt  *time.Time `json:"completedAt"`
	DurationMS   int64      `json:"durationMs"`
	Tokens       Tokens     `json:"tokens"`
	CostUSD      float64    `json:"costUsd"`
	StartedBy    Principal  `json:"startedBy"`
}

type ExecutionLog struct {
	ID          string                 `json:"id"`
	ExecutionID string                 `json:"executionId"`
	Timestamp   time.Time              `json:"timestamp"`
	Level       string                 `json:"level"`
	NodeID      string                 `json:"nodeId"`
	Message     string                 `json:"message"`
	Metadata    map[string]interface{} `json:"metadata"`
}

type ExecutionStep struct {
	ID          string     `json:"id"`
	NodeID      string     `json:"nodeId"`
	Label       string     `json:"label"`
	Status      string     `json:"status"`
	StartedAt   time.Time  `json:"startedAt"`
	CompletedAt *time.Time `json:"completedAt"`
	DurationMS  *int64     `json:"durationMs"`
}

type HealingReport struct {
	ExecutionID string                   `json:"executionId"`
	WorkflowID  string                   `json:"workflowId"`
	Status      string                   `json:"status"`
	Summary     string                   `json:"summary"`
	Events      []map[string]interface{} `json:"events"`
	Metrics     map[string]interface{}   `json:"metrics"`
}

type RunWorkflowRequest struct {
	Input          map[string]interface{} `json:"input"`
	Mode           string                 `json:"mode"`
	DryRun         bool                   `json:"dryRun"`
	IdempotencyKey string                 `json:"idempotencyKey"`
}

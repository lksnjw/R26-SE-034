package runner

import (
	"github.com/sanjeewa/agentic-orchestrator/internal/models"
	"github.com/sanjeewa/agentic-orchestrator/pkg/parser"
)

type StateManager struct {
	state models.RunnerState
}

func NewStateManager(state models.RunnerState) *StateManager {
	if state.Variables == nil {
		state.Variables = map[string]interface{}{}
	}
	return &StateManager{state: state}
}

func (m *StateManager) Resolve(params map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{}, len(params))
	for key, value := range params {
		out[key] = parser.ResolveVariables(value, m.state.Variables)
	}
	return out
}

func (m *StateManager) Save(stepID string, result map[string]interface{}) {
	m.state.Variables[stepID] = result
}

func (m *StateManager) Snapshot() map[string]interface{} {
	return m.state.Variables
}

package cli

import (
	"strings"
	"testing"
)

func TestAgentActionableError_Error(t *testing.T) {
	err := &AgentActionableError{
		ErrorCode: "TEST_ERR",
		Message:   "Something went wrong",
		Code:      CodeBadArgs,
	}

	errMsg := err.Error()
	if !strings.Contains(errMsg, "TEST_ERR") {
		t.Errorf("Error message should contain ErrorCode, got %v", errMsg)
	}
	if !strings.Contains(errMsg, "Something went wrong") {
		t.Errorf("Error message should contain Message, got %v", errMsg)
	}
}

func TestNewError(t *testing.T) {
	err := NewError(CodeNotFound, "NOT_FOUND", "Item not found", "Try another ID")

	if err.Code != CodeNotFound {
		t.Errorf("Expected code %d, got %d", CodeNotFound, err.Code)
	}
	if err.ErrorCode != "NOT_FOUND" {
		t.Errorf("Expected ErrorCode NOT_FOUND, got %v", err.ErrorCode)
	}
	if err.Suggestion != "Try another ID" {
		t.Errorf("Expected Suggestion 'Try another ID', got %v", err.Suggestion)
	}
}

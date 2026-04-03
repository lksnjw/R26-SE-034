package models

import "time"

type APIResponse struct {
	Success bool        `json:"success"`
	Data    interface{} `json:"data"`
	Message string      `json:"message"`
	Meta    interface{} `json:"meta"`
}

func OK(data interface{}, message string, meta interface{}) APIResponse {
	if message == "" {
		message = "OK"
	}

	return APIResponse{
		Success: true,
		Data:    data,
		Message: message,
		Meta:    meta,
	}
}

func Fail(message string, meta interface{}) APIResponse {
	if message == "" {
		message = "Request failed"
	}

	return APIResponse{
		Success: false,
		Data:    nil,
		Message: message,
		Meta:    meta,
	}
}

type PaginationMeta struct {
	Page       int    `json:"page"`
	Limit      int    `json:"limit"`
	Total      int    `json:"total"`
	TotalPages int    `json:"totalPages"`
	Sort       string `json:"sort,omitempty"`
}

type Principal struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type ResourceRef struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type LoginRequest struct {
	Email      string `json:"email" validate:"required,email"`
	Password   string `json:"password" validate:"required"`
	RememberMe bool   `json:"rememberMe"`
}

type RegisterRequest struct {
	Name             string `json:"name" validate:"required"`
	Email            string `json:"email" validate:"required,email"`
	Password         string `json:"password" validate:"required,min=8"`
	OrganizationName string `json:"organizationName"`
}

type TokenPair struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	ExpiresIn    int    `json:"expiresIn"`
}

type AuthSession struct {
	AccessToken  string      `json:"accessToken"`
	RefreshToken string      `json:"refreshToken"`
	ExpiresIn    int         `json:"expiresIn"`
	User         interface{} `json:"user"`
}

type Usage struct {
	InputTokens  int     `json:"inputTokens"`
	OutputTokens int     `json:"outputTokens"`
	TotalTokens  int     `json:"totalTokens,omitempty"`
	CostUSD      float64 `json:"costUsd"`
}

type Tokens struct {
	Input  int `json:"input"`
	Output int `json:"output"`
	Total  int `json:"total"`
}

type ValidationIssue struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	NodeID  string `json:"nodeId,omitempty"`
}

type ValidationCheck struct {
	Name   string `json:"name"`
	Passed bool   `json:"passed"`
}

type ValidationResult struct {
	Valid    bool              `json:"valid"`
	Score    float64           `json:"score"`
	Errors   []ValidationIssue `json:"errors"`
	Warnings []ValidationIssue `json:"warnings"`
	Checks   []ValidationCheck `json:"checks"`
}

type UploadedFile struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	MimeType  string    `json:"mimeType"`
	SizeBytes int64     `json:"sizeBytes"`
	URL       string    `json:"url"`
	Checksum  string    `json:"checksum"`
	CreatedAt time.Time `json:"createdAt"`
}

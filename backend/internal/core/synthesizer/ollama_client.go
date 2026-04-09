package synthesizer

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type OllamaClient struct {
	BaseURL string
	Model   string
	Enabled bool
	HTTP    *http.Client
}

type Service struct {
	Ollama *OllamaClient
	Prompt PromptBuilder
}

type Result struct {
	YAML       string                 `json:"yaml"`
	Confidence float64                `json:"confidence"`
	Usage      map[string]interface{} `json:"usage"`
}

func NewService(baseURL, model string, enabled bool) *Service {
	return &Service{
		Ollama: &OllamaClient{
			BaseURL: baseURL,
			Model:   model,
			Enabled: enabled,
			HTTP:    &http.Client{Timeout: 45 * time.Second},
		},
		Prompt: NewPromptBuilder(),
	}
}

func (s *Service) Synthesize(ctx context.Context, userPrompt, mode, model string, context map[string]interface{}) (Result, error) {
	prompt := s.Prompt.Build(userPrompt, mode, context)
	yamlText, err := s.Ollama.Generate(ctx, prompt, model)
	if err != nil {
		yamlText = FallbackYAML(userPrompt)
	}

	return Result{
		YAML:       yamlText,
		Confidence: 0.91,
		Usage: map[string]interface{}{
			"inputTokens":  1210,
			"outputTokens": 830,
			"costUsd":      0.0,
			"localModel":   s.Ollama.Model,
			"fallback":     err != nil,
		},
	}, nil
}

func (c *OllamaClient) Generate(ctx context.Context, prompt, overrideModel string) (string, error) {
	if !c.Enabled {
		return "", fmt.Errorf("ollama synthesis disabled")
	}

	model := c.Model
	if overrideModel != "" {
		model = overrideModel
	}

	body, err := json.Marshal(map[string]interface{}{
		"model":  model,
		"prompt": prompt,
		"stream": false,
		"options": map[string]interface{}{
			"temperature": 0.1,
		},
	})
	if err != nil {
		return "", fmt.Errorf("encode ollama request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+"/api/generate", bytes.NewReader(body))
	if err != nil {
		return "", fmt.Errorf("create ollama request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return "", fmt.Errorf("call ollama: %w", err)
	}
	defer resp.Body.Close()

	var payload struct {
		Response string `json:"response"`
		Error    string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", fmt.Errorf("decode ollama response: %w", err)
	}
	if resp.StatusCode >= 400 || payload.Error != "" {
		return "", fmt.Errorf("ollama returned %d: %s", resp.StatusCode, payload.Error)
	}

	return payload.Response, nil
}

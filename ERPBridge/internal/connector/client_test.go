package connector

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClient_Call_APIKey(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "test-key" {
			t.Errorf("expected Authorization header, got %s", r.Header.Get("Authorization"))
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	client := NewClient(slog.Default())
	ep := EndpointConfig{
		Method:  http.MethodGet,
		Path:    "/test",
		BaseURL: ts.URL,
		Auth: AuthConfig{
			Type: "api-key",
			Key:  "test-key",
		},
	}

	resp, err := client.Call(context.Background(), ep, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected status 200, got %d", resp.StatusCode)
	}
}

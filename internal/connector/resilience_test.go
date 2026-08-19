package connector

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/nimendra/ERPBridge/internal/logger"
	"github.com/sony/gobreaker"
	"github.com/stretchr/testify/assert"
)

func TestClient_Call_Retry(t *testing.T) {
	log := logger.Init()
	client := NewClient(log)

	var attempts int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		count := atomic.AddInt32(&attempts, 1)
		if count < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer server.Close()

	ep := EndpointConfig{
		Method:  http.MethodGet,
		Path:    "",
		BaseURL: server.URL,
	}

	resp, err := client.Call(context.Background(), ep, nil, nil)
	assert.NoError(t, err)
	assert.Equal(t, http.StatusOK, resp.StatusCode)
	assert.Equal(t, int32(3), atomic.LoadInt32(&attempts))
}

func TestClient_Call_CircuitBreaker(t *testing.T) {
	log := logger.Init()
	client := NewClient(log)

	// Configure CB to trip after 1 failure
	client.cb = gobreaker.NewCircuitBreaker(gobreaker.Settings{
		Name:        "TestCB",
		MaxRequests: 1,
		ReadyToTrip: func(counts gobreaker.Counts) bool {
			return counts.TotalFailures >= 1
		},
	})

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	ep := EndpointConfig{
		Method:  http.MethodGet,
		Path:    "",
		BaseURL: server.URL,
	}

	// 1st failure (and all 3 retries) -> should trip CB
	_, err := client.Call(context.Background(), ep, nil, nil)
	assert.Error(t, err)

	// next call -> should be fast-fail by CB
	_, err = client.Call(context.Background(), ep, nil, nil)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "circuit breaker is open")
}

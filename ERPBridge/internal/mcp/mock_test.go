package mcp

import (
	"context"
	"io"
	"net/http"
	"net/url"

	"github.com/nmdra/ERPBridge/internal/connector"
)

// MockConnector is a manual mock for the ERPConnector interface.
type MockConnector struct {
	CallFunc func(ctx context.Context, ep connector.EndpointConfig, queryParams url.Values, body io.Reader) (*http.Response, error)
}

func (m *MockConnector) Call(ctx context.Context, ep connector.EndpointConfig, queryParams url.Values, body io.Reader) (*http.Response, error) {
	if m.CallFunc != nil {
		return m.CallFunc(ctx, ep, queryParams, body)
	}
	return nil, nil
}

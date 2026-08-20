package mcp

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/url"
	"testing"

	"github.com/nimendra/ERPBridge/internal/connector"
	"github.com/stretchr/testify/assert"
)

func TestResource_Execute(t *testing.T) {
	mockConn := &MockConnector{
		CallFunc: func(_ context.Context, ep connector.EndpointConfig, _ url.Values, _ io.Reader) (*http.Response, error) {
			assert.Equal(t, http.MethodGet, ep.Method)
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(bytes.NewBufferString(`{"stock": 100}`)),
			}, nil
		},
	}

	r := &Resource{
		Name:        "inventory-stock",
		Description: "Stock levels",
		URITemplate: "erp://inventory/stock",
		MimeType:    "application/json",
		Execution: Execution{
			Method:   http.MethodGet,
			Endpoint: "/inventory/stock",
		},
	}

	res, err := r.Execute(context.Background(), "erp://inventory/stock", mockConn)
	assert.NoError(t, err)
	assert.Equal(t, `{"stock": 100}`, res)
}

func TestResource_Execute_NoEndpoint(t *testing.T) {
	r := &Resource{
		Name: "invalid-resource",
	}
	_, err := r.Execute(context.Background(), "erp://invalid", nil)
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "no endpoint configuration")
}

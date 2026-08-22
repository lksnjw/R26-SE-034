package cli

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/nmdra/ERPBridge/internal/idp"
	"github.com/stretchr/testify/require"
)

const (
	testAPIName      = "test-api"
	testURL          = "http://test"
	testActiveStatus = "active"
)

func TestAPIRegistrationResponse_RenderTable(t *testing.T) {
	resp := &APIRegistrationResponse{
		API: idp.API{
			Name:   testAPIName,
			ID:     "123",
			Module: "finance",
			Method: http.MethodGet,
			URL:    testURL,
			Status: testActiveStatus,
		},
	}
	var buf bytes.Buffer
	err := resp.RenderTable(&buf)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	out := buf.String()
	if !bytes.Contains([]byte(out), []byte(testAPIName)) {
		t.Errorf("expected output to contain 'test-api'")
	}
}

func TestAPIListResponse_RenderTable(t *testing.T) {
	resp := &APIListResponse{
		Items: []idp.API{
			{ID: "1", Name: "api1", Module: "hr", Method: http.MethodPost, Status: testActiveStatus},
		},
	}
	var buf bytes.Buffer
	err := resp.RenderTable(&buf)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	out := buf.String()
	if !bytes.Contains([]byte(out), []byte("api1")) {
		t.Errorf("expected output to contain 'api1'")
	}
}

func TestAPITestResponse_RenderTable(t *testing.T) {
	resp := &APITestResponse{
		API: idp.API{
			Name:       testAPIName,
			Method:     http.MethodGet,
			URL:        testURL,
			AuthType:   "api-key",
			AuthHeader: "X-Api-Key",
		},
		Status:    "200 OK",
		Latency:   time.Millisecond,
		IsSuccess: true,
	}
	var buf bytes.Buffer
	err := resp.RenderTable(&buf)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	out := buf.String()
	if !bytes.Contains([]byte(out), []byte(testAPIName)) {
		t.Errorf("expected output to contain 'test-api'")
	}

	resp.IsSuccess = false
	buf.Reset()
	require.NoError(t, resp.RenderTable(&buf))
	out = buf.String()
	if !bytes.Contains([]byte(out), []byte("failed")) {
		t.Errorf("expected output to contain 'failed'")
	}
}

func TestApiListCmd(t *testing.T) {
	setupTest()
	var buf bytes.Buffer
	formatter.Out = &buf

	err := apiListCmd.RunE(apiListCmd, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestApiTestCmd(t *testing.T) {
	setupTest()

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success": true}`))
	}))
	defer ts.Close()

	reg, err := idp.NewRegistry("", RootLog)
	require.NoError(t, err)
	api := &idp.API{
		Name:   "testapi",
		Method: http.MethodGet,
		URL:    ts.URL,
	}
	require.NoError(t, reg.Register(api))

	var buf bytes.Buffer
	formatter.Out = &buf
	apiTestCmd.SetContext(context.Background())
	err = apiTestCmd.RunE(apiTestCmd, []string{"testapi"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestApiRegisterCmd(t *testing.T) {
	setupTest()
	var buf bytes.Buffer
	formatter.Out = &buf

	require.NoError(t, apiRegisterCmd.Flags().Set("name", "newapi"))
	require.NoError(t, apiRegisterCmd.Flags().Set("url", "http://test"))
	require.NoError(t, apiRegisterCmd.Flags().Set("module", "hr"))
	require.NoError(t, apiRegisterCmd.Flags().Set("description", "test desc"))

	err := apiRegisterCmd.RunE(apiRegisterCmd, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/nimendra/ERPBridge/internal/cache"
	"github.com/nimendra/ERPBridge/internal/connector"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

// Tool represents a versioned, protocol-compliant MCP tool resource.
type Tool struct {
	APIVersion string   `json:"apiVersion"`
	Kind       string   `json:"kind"`
	Metadata   Metadata `json:"metadata"`
	Spec       ToolSpec `json:"spec"`

	// Handler is an optional native Go function to handle the tool call.
	Handler func(ctx context.Context, args map[string]any) (*ToolResult, error) `json:"-"`
}

// Metadata contains identity and lifecycle information for a tool.
type Metadata struct {
	Name     string `json:"name"`
	Version  string `json:"version"` // SemVer
	Module   string `json:"module"`
	Status   string `json:"status,omitempty"`   // ready, degraded
	IsActive bool   `json:"isActive,omitempty"` // for soft-delete/visibility
}

// ToolSpec defines the behavior, interface, and execution details of a tool.
type ToolSpec struct {
	Description  Description   `json:"description"`
	InputSchema  InputSchema   `json:"inputSchema"`
	OutputSchema *any          `json:"outputSchema,omitempty"`
	Execution    Execution     `json:"execution"`
	Cache        *cache.Config `json:"cache,omitempty"`
	Security     Security      `json:"security"`
	Routing      *Routing      `json:"routing,omitempty"`
	Lifecycle    *Lifecycle    `json:"lifecycle,omitempty"`
}

// Description provides rich semantic information to the LLM.
type Description struct {
	Short        string   `json:"short"`
	WhenToUse    []string `json:"whenToUse"`
	WhenNotToUse []string `json:"whenNotToUse"`
	Examples     []string `json:"examples"`
}

// InputSchema defines the structure of arguments required by a tool.
type InputSchema struct {
	Type       string              `json:"type"`
	Properties map[string]Property `json:"properties"`
	Required   []string            `json:"required,omitempty"`
}

// Property describes a single field in a tool's input schema.
type Property struct {
	Type        string   `json:"type"`
	Description string   `json:"description,omitempty"`
	Enum        []string `json:"enum,omitempty"`
	Default     any      `json:"default,omitempty"`
}

// Execution defines how the tool call is mapped to an ERP API.
type Execution struct {
	Type         string            `json:"type"` // "http"
	Method       string            `json:"method"`
	Endpoint     string            `json:"endpoint"`
	Mapping      map[string]string `json:"mapping,omitempty"`      // Maps LLM arg name -> ERP arg name
	ResponsePath string            `json:"responsePath,omitempty"` // JSONPath to unwrap response
}

// Security defines the authentication requirements for the tool.
type Security struct {
	AuthType      string `json:"authType"`      // api-key, basic, bearer
	CredentialRef string `json:"credentialRef"` // Env var name or vault key
}

// Routing provides metadata to improve LLM tool selection accuracy.
type Routing struct {
	Priority    float64  `json:"priority"`
	Signals     []string `json:"signals"`
	AntiSignals []string `json:"antiSignals"`
}

// Lifecycle defines the support status of a specific tool version.
type Lifecycle struct {
	Status       string `json:"status"` // stable, deprecated, sunset
	DeprecatedAt string `json:"deprecatedAt,omitempty"`
	SunsetAt     string `json:"sunsetAt,omitempty"`
	Replacement  string `json:"replacement,omitempty"`
}

// ToolCallRequest represents an incoming request from an MCP client to invoke a tool.
type ToolCallRequest struct {
	Name      string         `json:"name"`
	Arguments map[string]any `json:"arguments"`
}

// ToolResult encapsulates the outcome of a tool invocation.
type ToolResult struct {
	// Result contains the successful response data from the ERP.
	Result any `json:"result"`
	// Error contains details about a failed invocation.
	Error any `json:"error,omitempty"`
	// IsError indicates if the invocation failed.
	IsError bool `json:"isError,omitempty"`
}

// ERPConnector defines the interface for executing calls to external ERP systems.
type ERPConnector interface {
	Call(ctx context.Context, ep connector.EndpointConfig, queryParams url.Values, body io.Reader) (*http.Response, error)
}

// Execute performs the actual tool invocation by calling either a native handler or the underlying ERP API.
func (t *Tool) Execute(ctx context.Context, args map[string]any, conn ERPConnector) (*ToolResult, error) {
	if t.Handler != nil {
		return t.Handler(ctx, args)
	}

	if t.Spec.Execution.Endpoint == "" {
		return nil, fmt.Errorf("tool %s has no endpoint configuration", t.Metadata.Name)
	}

	// Apply argument mapping (LLM arg name -> ERP arg name)
	erpArgs := make(map[string]any)
	for k, v := range args {
		if mappedKey, ok := t.Spec.Execution.Mapping[k]; ok {
			erpArgs[mappedKey] = v
		} else {
			erpArgs[k] = v
		}
	}

	fullURL := t.Spec.Execution.Endpoint

	// Path parameter substitution
	for k, v := range erpArgs {
		placeholder := "{" + k + "}"
		if strings.Contains(fullURL, placeholder) {
			fullURL = strings.ReplaceAll(fullURL, placeholder, fmt.Sprintf("%v", v))
			delete(erpArgs, k) // Remove from args so it's not sent as query/body param
		}
	}

	queryParams := url.Values{}
	var body io.Reader

	if t.Spec.Execution.Method == http.MethodGet {
		for k, v := range erpArgs {
			queryParams.Set(k, fmt.Sprintf("%v", v))
		}
	} else if len(erpArgs) > 0 {
		data, err := json.Marshal(erpArgs)
		if err != nil {
			return nil, fmt.Errorf("marshal arguments: %w", err)
		}
		body = strings.NewReader(string(data))
	}

	envBaseURL := os.Getenv("ERP_BASE_URL")

	if envBaseURL != "" {
		u, err := url.Parse(fullURL)
		if err == nil {
			if u.IsAbs() {
				// If it's an absolute URL pointing to localhost, override it with ERP_BASE_URL
				if strings.HasPrefix(u.Host, "localhost") || strings.HasPrefix(u.Host, "127.0.0.1") || strings.HasPrefix(u.Host, "[::1]") {
					base, err := url.Parse(envBaseURL)
					if err == nil {
						u.Scheme = base.Scheme
						u.Host = base.Host
						fullURL = u.String()
					}
				}
			} else {
				// If it's a relative path, simply prepend the base URL
				fullURL = strings.TrimSuffix(envBaseURL, "/") + "/" + strings.TrimPrefix(fullURL, "/")
			}
		}
	} else if !strings.HasPrefix(fullURL, "http") {
		// Fallback for relative paths if no environment variable is set
		fullURL = "http://localhost:8081" + "/" + strings.TrimPrefix(fullURL, "/")
	}

	// Resolve CredentialRef from Environment Variables
	cred := os.Getenv(t.Spec.Security.CredentialRef)
	if cred == "" {
		// Fallback to literal if not found in env (supports local dev/testing)
		cred = t.Spec.Security.CredentialRef
	}

	ep := connector.EndpointConfig{
		Method:  t.Spec.Execution.Method,
		Path:    fullURL,
		BaseURL: "",
		Auth: connector.AuthConfig{
			Type: t.Spec.Security.AuthType,
			Key:  cred,
		},
	}

	resp, err := conn.Call(ctx, ep, queryParams, body)
	if err != nil {
		return nil, fmt.Errorf("erp call failed: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	var resultData any
	if err := json.NewDecoder(resp.Body).Decode(&resultData); err != nil {
		return nil, fmt.Errorf("decode erp response: %w", err)
	}

	// Unwrap response based on ResponsePath (simplistic implementation for top-level keys)
	if t.Spec.Execution.ResponsePath != "" && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if m, ok := resultData.(map[string]any); ok {
			if val, ok := m[t.Spec.Execution.ResponsePath]; ok {
				resultData = val
			}
		}
	}

	if t.Spec.OutputSchema != nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if err := validateResponse(resultData, t.Spec.OutputSchema); err != nil {
			return &ToolResult{
				Result:  resultData,
				Error:   fmt.Sprintf("response validation failed: %v", err),
				IsError: true,
			}, nil
		}
	}

	return &ToolResult{
		Result:  resultData,
		IsError: resp.StatusCode >= 400,
	}, nil
}

func validateResponse(data any, schema any) error {
	schemaBytes, err := json.Marshal(schema)
	if err != nil {
		return err
	}

	c := jsonschema.NewCompiler()
	if err := c.AddResource("schema.json", bytes.NewReader(schemaBytes)); err != nil {
		return fmt.Errorf("add resource: %w", err)
	}
	js, err := c.Compile("schema.json")
	if err != nil {
		return fmt.Errorf("compile: %w", err)
	}

	return js.Validate(data)
}

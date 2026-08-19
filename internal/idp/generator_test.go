package idp

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/nimendra/ERPBridge/internal/logger"
	"github.com/stretchr/testify/assert"
)

func TestGenerator_GenerateFromOpenAPI(t *testing.T) {
	log := logger.Init()
	tempDir, err := os.MkdirTemp("", "schemas")
	assert.NoError(t, err)
	defer func() { _ = os.RemoveAll(tempDir) }()

	gen := NewGenerator(tempDir, log)

	// Create a dummy OpenAPI file
	spec := `
openapi: 3.0.0
info:
  title: Test API
  version: 1.0.0
servers:
  - url: http://localhost:8081
paths:
  /test:
    get:
      operationId: getTest
      summary: Get test data
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  foo: {type: string}
`
	specPath := filepath.Join(tempDir, "spec.yaml")
	err = os.WriteFile(specPath, []byte(spec), 0600)
	assert.NoError(t, err)

	api := API{
		Name:   "test",
		Module: "finance",
	}

	tools, err := gen.GenerateFromOpenAPI(context.Background(), api, specPath)
	assert.NoError(t, err)
	assert.Len(t, tools, 1)
	assert.Equal(t, "gettest", tools[0].Metadata.Name)
	assert.Equal(t, "Get test data", tools[0].Spec.Description.Short)

	// Verify file was saved
	toolPath := filepath.Join(tempDir, "finance", "gettest.json")
	_, err = os.Stat(toolPath)
	assert.NoError(t, err)
}

func TestGenerator_Generate(t *testing.T) {
	log := logger.Init()
	tempDir, err := os.MkdirTemp("", "schemas")
	assert.NoError(t, err)
	defer func() { _ = os.RemoveAll(tempDir) }()

	gen := NewGenerator(tempDir, log)

	api := API{
		Name:        "simple-test",
		Description: "A simple test",
		Module:      "hr",
		Method:      "GET",
		URL:         "/hr/test",
	}

	tool, err := gen.Generate(api)
	assert.NoError(t, err)
	assert.Equal(t, "simple-test", tool.Metadata.Name)
	assert.Equal(t, "A simple test", tool.Spec.Description.Short)

	toolPath := filepath.Join(tempDir, "hr", "simple-test.json")
	_, err = os.Stat(toolPath)
	assert.NoError(t, err)
}

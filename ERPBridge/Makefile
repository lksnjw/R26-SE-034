# Variables
BINARY_SERVER=erpbridge-server
BINARY_CLI=bridgectl
BUILD_DIR=dist
DB_PATH=data/erpbridge.db
MOCK_ERP_DIR=mock-erp
MOCK_ERP_PORT=8081
SERVER_PORT=8080

.PHONY: all build clean test lint run-mock run-server generate-tools setup

all: build

# Build both server and CLI
build:
	@echo "Building binaries..."
	@go build -o $(BINARY_SERVER) ./services/erpbridge-server/main.go
	@go build -o $(BINARY_CLI) ./tools/bridgectl/main.go

# Clean up binaries and data
clean:
	@echo "Cleaning up..."
	@rm -f $(BINARY_SERVER) $(BINARY_CLI)
	@rm -rf $(BUILD_DIR)
	@rm -f $(DB_PATH)
	@rm -rf schemas/erp schemas/mock-erp

# Run tests
test:
	@echo "Running tests..."
	@go test ./...

# Run linter (requires golangci-lint)
lint:
	@echo "Running linter..."
	@golangci-lint run ./...

# Start the Mock ERP server (requires uv)
run-mock:
	@echo "Starting Mock ERP on port $(MOCK_ERP_PORT)..."
	@cd $(MOCK_ERP_DIR) && uv run main.py

# Start the ERPBridge server
run-server: build
	@echo "Starting ERPBridge Server on port $(SERVER_PORT)..."
	@DATABASE_PATH=$(DB_PATH) ./$(BINARY_SERVER)

# Setup development environment
setup:
	@echo "Setting up development environment..."
	@go mod tidy
	@cd $(MOCK_ERP_DIR) && uv sync

# Generate and apply tools for the ERP module
generate-tools: build
	@echo "Generating and applying tools from Mock ERP OpenAPI..."
	@# Ensure server is running or use a temporary one? 
	@# Usually this assumes the server is reachable at its default port.
	@./$(BINARY_CLI) api register --name erp --url http://localhost:$(MOCK_ERP_PORT) --module erp --description "Mock ERP"
	@mkdir -p schemas/erp
	@./$(BINARY_CLI) tool generate --api erp --openapi $(MOCK_ERP_DIR)/openapi.yaml -o yaml > schemas/erp/generated.yaml
	@./$(BINARY_CLI) tool apply -f schemas/erp/
	@echo "Tools applied successfully."

# Help
help:
	@echo "Available targets:"
	@echo "  build           Build server and CLI binaries"
	@echo "  clean           Remove binaries and data"
	@echo "  test            Run Go tests"
	@echo "  lint            Run Go linter"
	@echo "  run-mock        Start Mock ERP (FastAPI)"
	@echo "  run-server      Start ERPBridge Server"
	@echo "  setup           Install Go and Python dependencies"
	@echo "  generate-tools  Generate tools from OpenAPI and apply to registry"

APP=agentic-orchestrator

.PHONY: run build test tidy fmt

run:
	go run ./cmd/server

build:
	go build -o bin/$(APP) ./cmd/server

test:
	go test ./...

tidy:
	go mod tidy

fmt:
	gofmt -w .

APP=agentic-orchestrator

.PHONY: run build test tidy fmt

run:
	go run -buildvcs=false ./cmd/server

build:
	go build -buildvcs=false -o bin/$(APP) ./cmd/server

test:
	go test ./...

tidy:
	go mod tidy

fmt:
	gofmt -w .

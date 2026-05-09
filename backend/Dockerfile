FROM golang:1.22-alpine AS build

WORKDIR /app
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN go build -o /agentic-orchestrator ./cmd/server

FROM alpine:3.20
WORKDIR /app
COPY --from=build /agentic-orchestrator /usr/local/bin/agentic-orchestrator
COPY .env.example .env.example
COPY dataset ./dataset
EXPOSE 8080
CMD ["agentic-orchestrator"]

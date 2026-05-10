# API Handlers Documentation

This directory contains the HTTP handlers for the Low-Code Workflow Engine. These handlers manage the lifecycle of requests, from authentication and validation to orchestrating core business logic and returning standardized responses.

## Overview

The handlers are implemented as methods on a shared `Handler` struct, which serves as a dependency injection container. This design ensures that all handlers have access to the necessary core services, repositories, and configurations.

### The Base Handler (`handler.go`)

The central `Handler` struct holds references to:
- **Core Services:** `Synthesizer`, `Orchestrator`, `Runner` (Executor), `Healer`, `Search` (Semantic), and `Validator`.
- **Infrastructure:** `Store` (Repository), `Config`, and `Logger`.

Common utilities provided by the base handler include:
- `parseBody`: Standardized JSON body parsing.
- `currentUserID`/`currentUser`: Extraction of identity from context (populated by auth middleware).
- `tokenForUser`: JWT generation logic.
- `paginate`: Generic helper for list responses.

---

## Primary Handlers

### Chat Handler (`chat_handler.go`)
**Role:** The entry point for the "Agentic" experience.
- **Functionality:** Manages chat sessions and processes natural language requests to create or modify workflows.
- **Core Interaction:** 
    - Calls the `Orchestrator` to handle complex multi-step reasoning, tool retrieval, and candidate generation.
    - Uses the `Synthesizer` as a fallback or for direct YAML generation.
- **Response:** Returns chat messages paired with "artifacts" like generated YAML, validation results, and flow previews.

### Execute Handler (`execute_handler.go`)
**Role:** Manages the lifecycle of workflow runs.
- **Functionality:** Starts, cancels, and retries workflow executions.
- **Core Interaction:**
    - **Validation:** Performs strict registry and schema validation before execution using the `Validator`.
    - **Execution:** Delegates the actual step-by-step execution to the `Runner`.
    - **Self-Healing:** If execution fails, it invokes the `Healer` to attempt automatic YAML repair based on the error trace.
- **Response:** Returns execution status, logs, and detailed healing reports.

### Workflow Handler (`workflow_handler.go`)
**Role:** CRUD and lifecycle management for workflow definitions.
- **Functionality:** Manages YAML definitions, canvas layouts, version history, and templates.
- **Core Interaction:** Uses the `Validator` to ensure any saved or updated YAML is syntactically and semantically correct.
- **Response:** Provides full workflow details, including "Canvas" data used for the visual low-code editor.

---

## Supporting Handlers

### Auth & Profile Handlers
- **`auth_handler.go`**: Manages the authentication lifecycle (Login, Register, OAuth, 2FA).
- **`profile_handler.go`**: Handles user-specific settings, security preferences, and API key management.

### Admin & Settings Handlers
- **`admin_handler.go`**: Provides administrative controls for User/Role management and viewing system-wide audit logs.
- **`settings_handler.go`**: Manages global system configuration, external webhooks, and third-party integrations (MCP connectors).

### Catalog & Search Handlers
- **`catalog_handler.go`**: Exposes the "Registry" of available tools and governance rules.
- **Semantic Search:** Integrated here to allow users to search for capabilities using natural language, powered by the `Search` service.

### Analytics & Dashboard Handlers
- **`analytics_handler.go`**: Aggregates metrics on success rates, latency, and cost trends.
- **`dashboard_handler.go`**: Provides a high-level summary of system health, recent activity, and key performance indicators.

### Notification & Websocket Handlers
- **`notification_handler.go`**: Manages in-app alerts and file uploads.
- **`websocket_handler.go`**: Provides a real-time stream for system events (e.g., execution updates, health changes).

---

## Request / Response Flow

1.  **Request Reception:** Fiber routes the request to a specific `Handler` method.
2.  **Authentication:** Handlers assume the `UserID` is available in the context (verified by middleware).
3.  **Parsing & Validation:** Input is parsed into model structs and validated.
4.  **Core Orchestration:** The handler calls the relevant `core/` service (e.g., `Orchestrator.HandleChatMessage`).
5.  **State Persistence:** Results or changes are persisted via the `Store`.
6.  **Response Construction:** Standardized JSON responses are returned using `models.OK` or `models.Fail`.

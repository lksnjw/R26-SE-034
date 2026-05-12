# API Layer (`internal/api/`)

The `internal/api/` directory contains the web layer of the application, built using the **Fiber** web framework. It is organized into routes, middlewares, and handlers to provide a clean separation of concerns.

## Structure Overview

*   **`routes/`**: Centralized endpoint definitions.
*   **`middlewares/`**: Cross-cutting concerns like authentication, logging, and RBAC.
*   **`handlers/`**: The business logic controllers that process requests and interact with core services.

## Key Technologies

*   **Fiber (v2)**: A high-performance web framework for Go.
*   **JWT (v5)**: Used for secure, stateless authentication.
*   **WebSockets**: Supported via Fiber's websocket contrib package for real-time events.

## Request/Response Lifecycle

1.  **Entry**: `main.go` initializes the Fiber app and applies global middlewares (CORS, Logger).
2.  **Routing**: The request matches a route defined in `routes/routes.go`.
3.  **Middleware**: If the route is protected, the `Auth` middleware validates the JWT and injects the `userID` into the context.
4.  **Handling**: The corresponding method in a `Handler` is executed.
5.  **Validation**: Handlers often use the `Validator` service to ensure business rules are met.
6.  **Response**: Handlers return a standardized JSON response using the `internal/models` package (e.g., `models.OK` or `models.Fail`).

# Backend Connection Map

The frontend currently uses mock services. Replace each mock service with `apiClient` calls from `frontend/src/config/axios.js`.

## Environment

```env
VITE_API_BASE_URL=http://localhost:8080/api
VITE_WS_BASE_URL=ws://localhost:8080/ws
VITE_APP_NAME="Agentic Workflow Engine"
VITE_SENTRY_DSN=""
VITE_ANALYTICS_ENABLED=false
```

## Frontend Service Mapping

| Frontend File | Backend API Group |
|---|---|
| `src/services/auth.service.js` | `/auth`, OAuth, 2FA |
| `src/services/workflow.service.js` | `/workflows`, `/workflows/templates` |
| `src/services/synthesis.service.js` | `/synthesis`, `/chat/sessions` |
| `src/services/execution.service.js` | `/executions`, `/workflows/:id/executions` |
| `src/services/analytics.service.js` | `/analytics` |
| `src/services/user.service.js` | `/users`, `/roles`, `/permissions` |
| `src/services/settings.service.js` | `/settings`, `/settings/webhooks` |
| `src/services/integration.service.js` | `/integrations` |
| `src/services/notification.service.js` | `/notifications` |
| `src/services/audit.service.js` | `/audit` |
| `src/services/upload.service.js` | `/upload` |
| `src/hooks/useWebSocket.js` | `/ws/*` |

## Required Backend Capabilities

1. JWT auth with access token and refresh token.
2. RBAC middleware for permissions such as `workflow:read`, `workflow:write`, `workflow:run`, `user:manage`, `settings:manage`, `audit:read`.
3. Workflow persistence with YAML and canvas node/edge state.
4. Workflow execution engine with async run creation and status updates.
5. LLM synthesis service that converts natural language into YAML.
6. Validation service for YAML schema, node graph integrity, and policy guardrails.
7. WebSocket gateway for live logs, run status, notifications, and system health.
8. Audit logging for auth, workflow, execution, user, role, setting, integration, and API-key actions.
9. Upload/import support for YAML, JSON, CSV, and attachments.
10. Analytics aggregation for runs, cost, token usage, latency, healing success, and validation scores.

## Axios Integration Pattern

```js
import { apiClient } from "../config/axios";

export const workflowService = {
  async list(params) {
    const response = await apiClient.get("/workflows", { params });
    return response.data.data;
  },
};
```

## Rollout Order

1. Auth and current-user session.
2. Dashboard summary/activity/health.
3. Workflow list/detail/create/update.
4. Synthesis and YAML validation.
5. Execution run/create/logs.
6. WebSocket live logs/status.
7. Analytics.
8. Users/RBAC/audit.
9. Settings/integrations/webhooks.
10. Upload/import and notifications.


# Agentic Workflow Engine API Contract

This folder documents the backend API required by the frontend in `frontend/`.

Frontend defaults:

```env
VITE_API_BASE_URL=http://localhost:8080/api
VITE_WS_BASE_URL=ws://localhost:8080/ws
```

All REST endpoints below are relative to `/api`. All realtime endpoints are relative to `/ws`.

## Files

| File | Scope |
|---|---|
| [00-backend-connection-map.md](./00-backend-connection-map.md) | Frontend service files, env vars, auth connection, rollout order |
| [01-auth.md](./01-auth.md) | Login, register, refresh, password reset, 2FA, OAuth |
| [02-dashboard.md](./02-dashboard.md) | Dashboard metrics, activity, system health |
| [03-workflows.md](./03-workflows.md) | Workflow CRUD, YAML, canvas, versions, templates |
| [04-synthesis-chat.md](./04-synthesis-chat.md) | Natural language to YAML, chat sessions, validation |
| [05-executions.md](./05-executions.md) | Run history, run detail, logs, timeline, healing, retry/cancel |
| [06-analytics.md](./06-analytics.md) | KPI summary, charts, cost, latency, F1, heatmap |
| [07-users-rbac-audit.md](./07-users-rbac-audit.md) | Users, roles, permissions, invites, audit logs |
| [08-profile-api-keys.md](./08-profile-api-keys.md) | Profile, security, notifications, personal API keys |
| [09-settings-integrations-webhooks.md](./09-settings-integrations-webhooks.md) | App settings, LLM policy, RBAC policy, integrations, webhooks |
| [10-notifications-upload.md](./10-notifications-upload.md) | Notifications and uploads/imports |
| [11-realtime-websocket.md](./11-realtime-websocket.md) | WebSocket channels and event payloads |
| [12-data-models.md](./12-data-models.md) | Shared response wrapper and JSON data models |

## Shared Request Rules

Every protected request must include:

```http
Authorization: Bearer <accessToken>
Content-Type: application/json
```

File upload endpoints use:

```http
Authorization: Bearer <accessToken>
Content-Type: multipart/form-data
```

## Shared Success Response

```json
{
  "success": true,
  "data": {},
  "message": "OK",
  "meta": null
}
```

## Shared List Response

```json
{
  "success": true,
  "data": [],
  "message": "OK",
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5,
    "sort": "-createdAt"
  }
}
```

## Shared Error Response

```json
{
  "success": false,
  "data": null,
  "message": "Validation failed",
  "error": {
    "code": "VALIDATION_ERROR",
    "details": [
      {
        "field": "name",
        "message": "Workflow name is required"
      }
    ]
  }
}
```

## HTTP Status Codes

| Status | Meaning |
|---:|---|
| `200` | Request succeeded |
| `201` | Resource created |
| `202` | Async job accepted |
| `204` | Deleted or no response body |
| `400` | Invalid request |
| `401` | Not authenticated |
| `403` | Not authorized |
| `404` | Resource not found |
| `409` | Conflict, duplicate, stale version |
| `422` | Validation failed |
| `429` | Rate limited |
| `500` | Server error |


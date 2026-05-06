# Dashboard API

Base path: `/api/dashboard`

## Endpoints

| Method | Endpoint | Auth | Query Params | Success Response |
|---|---|---|---|---|
| `GET` | `/dashboard/summary` | Required | `range`, `timezone` | `DashboardSummary` |
| `GET` | `/dashboard/activity` | Required | `limit`, `cursor` | `ActivityItem[]` |
| `GET` | `/dashboard/health` | Required | none | `SystemHealth` |
| `GET` | `/dashboard/recent-workflows` | Required | `limit` | `WorkflowSummary[]` |

## Summary Response

```json
{
  "success": true,
  "data": {
    "metrics": [
      {
        "key": "activeWorkflows",
        "label": "Active Workflows",
        "value": 42,
        "formattedValue": "42",
        "delta": "+12.5%",
        "trend": "up",
        "icon": "tabler:git-branch",
        "tone": "primary"
      },
      {
        "key": "successfulRuns",
        "label": "Successful Runs",
        "value": 98.4,
        "formattedValue": "98.4%",
        "delta": "+2.1%",
        "trend": "up",
        "icon": "mdi:check-decagram-outline",
        "tone": "green"
      }
    ]
  },
  "message": "OK",
  "meta": {
    "range": "7d",
    "timezone": "Asia/Colombo"
  }
}
```

## Activity Response

```json
{
  "success": true,
  "data": [
    {
      "id": "act_001",
      "title": "Procurement Risk Escalation entered self-healing",
      "description": "Connector token refresh was attempted automatically.",
      "type": "healing",
      "tone": "purple",
      "icon": "mdi:shield-refresh-outline",
      "createdAt": "2026-05-02T09:15:00Z",
      "actor": {
        "id": "system",
        "name": "Execution Engine"
      },
      "resource": {
        "type": "workflow",
        "id": "wf-102"
      }
    }
  ],
  "message": "OK",
  "meta": {
    "nextCursor": null
  }
}
```

## Health Response

```json
{
  "success": true,
  "data": {
    "overall": "healthy",
    "services": [
      {
        "name": "Synthesis API",
        "status": "healthy",
        "value": 96,
        "meta": "p95 1.8s",
        "lastCheckedAt": "2026-05-02T09:20:00Z"
      },
      {
        "name": "Execution Workers",
        "status": "degraded",
        "value": 88,
        "meta": "12/14 healthy",
        "lastCheckedAt": "2026-05-02T09:20:00Z"
      }
    ]
  },
  "message": "OK",
  "meta": null
}
```


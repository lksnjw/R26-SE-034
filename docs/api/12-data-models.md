# Shared Data Models

These are the main backend models needed by the frontend.

## ApiResponse

```json
{
  "success": true,
  "data": {},
  "message": "OK",
  "meta": null
}
```

## PaginationMeta

```json
{
  "page": 1,
  "limit": 20,
  "total": 100,
  "totalPages": 5,
  "sort": "-createdAt"
}
```

## Workflow Status

```json
["PENDING", "RUNNING", "DONE", "FAILED", "HEALING"]
```

## WorkflowSummary

```json
{
  "id": "wf-101",
  "name": "ERP Invoice Exception Resolver",
  "owner": {
    "id": "team_ops",
    "name": "Ops Automation"
  },
  "status": "RUNNING",
  "trigger": "New invoice anomaly",
  "steps": 7,
  "successRate": 97.8,
  "lastRunAt": "2026-05-02T09:12:00Z",
  "description": "Detects mismatched supplier invoices and routes approvals."
}
```

## WorkflowNode

```json
{
  "id": "policy",
  "label": "Policy Guardrail",
  "type": "condition",
  "icon": "mdi:source-branch",
  "position": {
    "x": 595,
    "y": 72
  },
  "status": "RUNNING",
  "config": {
    "requiresApproval": true
  }
}
```

## WorkflowEdge

```json
{
  "id": "edge-policy-notify",
  "source": "policy",
  "target": "notify",
  "type": "conditional",
  "label": "approved"
}
```

## Execution

```json
{
  "id": "run-4821",
  "workflowId": "wf-101",
  "workflowName": "ERP Invoice Exception Resolver",
  "status": "RUNNING",
  "startedAt": "2026-05-02T09:21:09Z",
  "completedAt": null,
  "durationMs": 74000,
  "tokens": {
    "input": 5400,
    "output": 3000,
    "total": 8400
  },
  "costUsd": 0.31
}
```

## User

```json
{
  "id": "usr_001",
  "name": "Lakshan Jay",
  "email": "admin@workflow.local",
  "role": {
    "id": "role_admin",
    "name": "Platform Admin"
  },
  "permissions": ["workflow:read", "workflow:write"],
  "status": "Active",
  "initials": "LJ"
}
```

## Integration

```json
{
  "id": "int_erp_sandbox",
  "name": "ERP Sandbox",
  "type": "MCP Server",
  "status": "Connected",
  "icon": "mdi:server",
  "config": {
    "baseUrl": "https://erp.example.local"
  }
}
```

## AuditLog

```json
{
  "id": "audit_001",
  "actor": {
    "id": "usr_001",
    "name": "Lakshan Jay"
  },
  "action": "workflow.updated",
  "resource": {
    "type": "workflow",
    "id": "wf-101"
  },
  "before": {},
  "after": {},
  "createdAt": "2026-05-02T09:30:00Z"
}
```


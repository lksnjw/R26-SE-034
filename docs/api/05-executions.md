# Executions API

Base path: `/api/executions`

## Endpoints

| Method | Endpoint | Auth | Request / Query | Success Response |
|---|---|---|---|---|
| `GET` | `/executions` | Required | `page`, `limit`, `status`, `workflowId`, `from`, `to` | `Execution[]` |
| `GET` | `/executions/:id` | Required | none | `ExecutionDetail` |
| `GET` | `/executions/:id/logs` | Required | `cursor`, `limit`, `level` | `ExecutionLog[]` |
| `GET` | `/executions/:id/timeline` | Required | none | `ExecutionStep[]` |
| `GET` | `/executions/:id/events` | Required | `after`, `limit`, `waitMs` | `ExecutionEventPage` |
| `GET` | `/executions/:id/healing-report` | Required | none | `HealingReport` |
| `POST` | `/executions/:id/cancel` | Required | empty object | `Execution` |
| `POST` | `/executions/:id/retry` | Required | `RetryExecutionRequest` | `Execution` |
| `GET` | `/workflows/:id/executions` | Required | `page`, `limit` | `Execution[]` |
| `POST` | `/workflows/:id/run` | Required | `RunWorkflowRequest` | `Execution` |

## Run Workflow Request

```json
{
  "input": {
    "invoiceId": "INV-99214",
    "supplierId": "SUP-1001"
  },
  "mode": "test",
  "dryRun": false,
  "idempotencyKey": "run-request-20260502-001"
}
```

## Execution Response

```json
{
  "success": true,
  "data": {
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
    "costUsd": 0.31,
    "startedBy": {
      "id": "usr_001",
      "name": "Lakshan Jay"
    }
  },
  "message": "Execution started",
  "meta": null
}
```

## Execution Logs Response

```json
{
  "success": true,
  "data": [
    {
      "id": "log_001",
      "executionId": "run-4821",
      "timestamp": "2026-05-02T09:21:09Z",
      "level": "info",
      "nodeId": "trigger",
      "message": "trigger.erp_event received invoice_id=INV-99214",
      "metadata": {
        "invoiceId": "INV-99214"
      }
    }
  ],
  "message": "OK",
  "meta": {
    "nextCursor": "log_002"
  }
}
```

## Timeline Response

```json
{
  "success": true,
  "data": [
    {
      "id": "step_001",
      "nodeId": "trigger",
      "label": "ERP Event Trigger",
      "status": "DONE",
      "startedAt": "2026-05-02T09:21:09Z",
      "completedAt": "2026-05-02T09:21:11Z",
      "durationMs": 2000
    },
    {
      "id": "step_002",
      "nodeId": "policy",
      "label": "Policy Guardrail",
      "status": "RUNNING",
      "startedAt": "2026-05-02T09:21:18Z",
      "completedAt": null,
      "durationMs": null
    }
  ],
  "message": "OK",
  "meta": null
}
```

## Execution Event Page

`after` is a non-negative contiguous sequence cursor, `limit` is 1–100, and
`waitMs` is 0–25,000. With a positive wait and no newer saved event, an active
run request may remain open until a relevant commit or timeout. The response is
evidence replay only; it does not dispatch or retry the run.

```json
{
  "success": true,
  "data": {
    "events": [],
    "cursor": 12,
    "lastSequence": 12,
    "hasMore": false,
    "status": "RUNNING",
    "profile": "read-progress-v1",
    "waited": true,
    "waitedMs": 25000
  }
}
```

## Healing Report Response

```json
{
  "success": true,
  "data": {
    "executionId": "run-4821",
    "workflowId": "wf-101",
    "status": "RECOVERED",
    "summary": "ERP token refresh recovered the connector and resumed execution without duplicate downstream actions.",
    "events": [
      {
        "id": "heal_001",
        "type": "connector_token_refresh",
        "nodeId": "repair",
        "status": "success",
        "startedAt": "2026-05-02T09:21:27Z",
        "completedAt": "2026-05-02T09:22:03Z"
      }
    ],
    "metrics": {
      "recoveredInSeconds": 36,
      "duplicateWritesPrevented": true,
      "ownerNotified": true
    }
  },
  "message": "OK",
  "meta": null
}
```


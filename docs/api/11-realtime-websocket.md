# Realtime WebSocket API

Base URL: `ws://localhost:8080/ws`

Clients should include the access token either as a query param during development or through a secure auth handshake:

```text
ws://localhost:8080/ws/executions/run-4821/logs?token=<accessToken>
```

Preferred production handshake:

```json
{
  "type": "auth",
  "accessToken": "jwt-access-token"
}
```

## Channels

| Channel | Purpose |
|---|---|
| `/executions/:id/logs` | Live execution logs |
| `/executions/:id/status` | Run status transitions |
| `/workflows/:id/events` | Builder/canvas collaboration and workflow events |
| `/notifications` | User notifications |
| `/system-health` | Runtime health updates |

## Shared Event Envelope

```json
{
  "type": "execution.log.appended",
  "id": "evt_001",
  "timestamp": "2026-05-02T09:21:09Z",
  "data": {}
}
```

## Execution Log Event

```json
{
  "type": "execution.log.appended",
  "id": "evt_log_001",
  "timestamp": "2026-05-02T09:21:09Z",
  "data": {
    "executionId": "run-4821",
    "log": {
      "id": "log_001",
      "level": "info",
      "nodeId": "trigger",
      "message": "trigger.erp_event received invoice_id=INV-99214",
      "metadata": {
        "invoiceId": "INV-99214"
      }
    }
  }
}
```

## Execution Status Event

```json
{
  "type": "execution.status.changed",
  "id": "evt_status_001",
  "timestamp": "2026-05-02T09:22:03Z",
  "data": {
    "executionId": "run-4821",
    "workflowId": "wf-101",
    "previousStatus": "RUNNING",
    "status": "HEALING",
    "activeNodeId": "repair"
  }
}
```

## Workflow Canvas Event

```json
{
  "type": "workflow.canvas.updated",
  "id": "evt_canvas_001",
  "timestamp": "2026-05-02T09:25:00Z",
  "data": {
    "workflowId": "wf-101",
    "operation": "node.updated",
    "node": {
      "id": "policy",
      "label": "Policy Guardrail",
      "config": {
        "requiresApproval": true
      }
    },
    "actor": {
      "id": "usr_001",
      "name": "Lakshan Jay"
    }
  }
}
```

## Notification Event

```json
{
  "type": "notification.created",
  "id": "evt_not_001",
  "timestamp": "2026-05-02T09:50:00Z",
  "data": {
    "id": "not_001",
    "message": "ERP connector token expires soon",
    "tone": "warning",
    "read": false
  }
}
```

## System Health Event

```json
{
  "type": "system.health.changed",
  "id": "evt_health_001",
  "timestamp": "2026-05-02T09:55:00Z",
  "data": {
    "overall": "degraded",
    "service": {
      "name": "Execution Workers",
      "status": "degraded",
      "value": 88,
      "meta": "12/14 healthy"
    }
  }
}
```


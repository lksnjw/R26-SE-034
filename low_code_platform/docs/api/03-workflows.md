# Workflows API

Base path: `/api/workflows`

## Endpoints

| Method | Endpoint | Auth | Request / Query | Success Response |
|---|---|---|---|---|
| `GET` | `/workflows` | Required | `page`, `limit`, `status`, `q`, `ownerId`, `sort` | `WorkflowSummary[]` |
| `POST` | `/workflows` | Required | `CreateWorkflowRequest` | `WorkflowDetail` |
| `GET` | `/workflows/:id` | Required | none | `WorkflowDetail` |
| `PATCH` | `/workflows/:id` | Required | `UpdateWorkflowRequest` | `WorkflowDetail` |
| `DELETE` | `/workflows/:id` | Required | none | `{ "deleted": true }` |
| `POST` | `/workflows/:id/duplicate` | Required | `{ "name": "Copy name" }` | `WorkflowDetail` |
| `POST` | `/workflows/:id/publish` | Required | `{ "versionNote": "..." }` | `WorkflowVersion` |
| `POST` | `/workflows/:id/archive` | Required | none | `{ "archived": true }` |
| `POST` | `/workflows/:id/validate` | Required | none or `{ "yaml": "..." }` | `ValidationResult` |
| `POST` | `/workflows/:id/run` | Required | `RunWorkflowRequest` | `Execution` |
| `GET` | `/workflows/:id/yaml` | Required | none | `WorkflowYaml` |
| `PUT` | `/workflows/:id/yaml` | Required | `WorkflowYaml` | `WorkflowYaml` |
| `GET` | `/workflows/:id/canvas` | Required | none | `WorkflowCanvas` |
| `PUT` | `/workflows/:id/canvas` | Required | `WorkflowCanvas` | `WorkflowCanvas` |
| `GET` | `/workflows/:id/versions` | Required | `page`, `limit` | `WorkflowVersion[]` |
| `POST` | `/workflows/:id/restore/:versionId` | Required | none | `WorkflowDetail` |
| `GET` | `/workflows/templates` | Required | `category`, `q` | `WorkflowTemplate[]` |
| `POST` | `/workflows/templates` | Required | `CreateTemplateRequest` | `WorkflowTemplate` |
| `POST` | `/workflows/templates/:id/use` | Required | `{ "name": "..." }` | `WorkflowDetail` |

## Create Workflow Request

```json
{
  "name": "ERP Invoice Exception Resolver",
  "description": "Detects mismatched supplier invoices and routes approvals.",
  "ownerId": "team_ops",
  "trigger": {
    "type": "erp.invoice.created",
    "displayName": "New invoice anomaly",
    "config": {
      "source": "erp-sandbox",
      "event": "invoice.created"
    }
  },
  "yaml": "name: erp_invoice_exception_resolver\ntrigger:\n  type: erp.invoice.created",
  "tags": ["erp", "finance", "self-healing"]
}
```

## Workflow Detail Response

```json
{
  "success": true,
  "data": {
    "id": "wf-101",
    "name": "ERP Invoice Exception Resolver",
    "description": "Detects mismatched supplier invoices, classifies root cause, and routes approvals.",
    "owner": {
      "id": "team_ops",
      "name": "Ops Automation"
    },
    "status": "RUNNING",
    "trigger": {
      "type": "erp.invoice.created",
      "displayName": "New invoice anomaly",
      "config": {
        "source": "erp-sandbox",
        "event": "invoice.created"
      }
    },
    "steps": 7,
    "successRate": 97.8,
    "lastRunAt": "2026-05-02T09:12:00Z",
    "publishedVersion": 4,
    "draftVersion": 5,
    "tags": ["erp", "finance", "self-healing"],
    "createdAt": "2026-05-01T11:00:00Z",
    "updatedAt": "2026-05-02T09:12:00Z"
  },
  "message": "OK",
  "meta": null
}
```

## Workflow YAML Response

```json
{
  "success": true,
  "data": {
    "workflowId": "wf-101",
    "version": 5,
    "yaml": "name: ERP Invoice Exception Resolver\ntrigger:\n  type: erp.invoice.created\nsteps:\n  - id: classify_intent",
    "checksum": "sha256:1f4c...",
    "updatedAt": "2026-05-02T09:12:00Z"
  },
  "message": "OK",
  "meta": null
}
```

## Workflow Canvas Response

```json
{
  "success": true,
  "data": {
    "workflowId": "wf-101",
    "nodes": [
      {
        "id": "trigger",
        "label": "ERP Event Trigger",
        "type": "trigger",
        "position": { "x": 70, "y": 72 },
        "status": "DONE",
        "config": {
          "event": "erp.invoice.created"
        }
      }
    ],
    "edges": [
      {
        "id": "edge-trigger-classify",
        "source": "trigger",
        "target": "classify",
        "type": "default",
        "label": null
      }
    ],
    "viewport": {
      "x": 0,
      "y": 0,
      "zoom": 1
    }
  },
  "message": "OK",
  "meta": null
}
```

## Validation Response

```json
{
  "success": true,
  "data": {
    "valid": true,
    "score": 0.94,
    "errors": [],
    "warnings": [
      {
        "code": "RETRY_BUDGET_LOW",
        "message": "Self-healing retry budget is lower than recommended.",
        "nodeId": "repair"
      }
    ],
    "checks": [
      { "name": "Schema valid", "passed": true },
      { "name": "RBAC policy attached", "passed": true },
      { "name": "Retry budget configured", "passed": true }
    ]
  },
  "message": "Workflow is valid",
  "meta": null
}
```


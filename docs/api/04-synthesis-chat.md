# Synthesis and Chat API

Base paths: `/api/synthesis`, `/api/chat`

## Synthesis Endpoints

| Method | Endpoint | Auth | Request Body | Success Response |
|---|---|---|---|---|
| `POST` | `/synthesis` | Required | `SynthesisRequest` | `SynthesisResult` |
| `POST` | `/synthesis/validate` | Required | `{ "yaml": "..." }` | `ValidationResult` |
| `POST` | `/synthesis/preview-flow` | Required | `{ "yaml": "..." }` | `WorkflowCanvas` |
| `POST` | `/synthesis/explain` | Required | `{ "yaml": "..." }` | `ExplanationResult` |

## Chat Endpoints

| Method | Endpoint | Auth | Request / Query | Success Response |
|---|---|---|---|---|
| `GET` | `/chat/sessions` | Required | `page`, `limit`, `q` | `ChatSession[]` |
| `POST` | `/chat/sessions` | Required | `CreateChatSessionRequest` | `ChatSession` |
| `GET` | `/chat/sessions/:id` | Required | none | `ChatSessionDetail` |
| `PATCH` | `/chat/sessions/:id` | Required | `{ "title": "..." }` | `ChatSession` |
| `DELETE` | `/chat/sessions/:id` | Required | none | `{ "deleted": true }` |
| `POST` | `/chat/sessions/:id/messages` | Required | `CreateChatMessageRequest` | `ChatMessageResult` |

## Synthesis Request

```json
{
  "prompt": "When an ERP invoice is duplicated, classify the reason, retry connector failures, then notify finance.",
  "mode": "balanced",
  "model": "gpt-5.4",
  "context": {
    "organizationId": "org_001",
    "availableIntegrations": ["erp-sandbox", "github-actions"],
    "policyMode": "guarded"
  }
}
```

## Synthesis Result Response

```json
{
  "success": true,
  "data": {
    "yaml": "name: invoice_exception_resolver\ntrigger:\n  type: erp.invoice.created",
    "confidence": 0.91,
    "workflowDraft": {
      "name": "Invoice Exception Resolver",
      "steps": 7,
      "trigger": "erp.invoice.created"
    },
    "validation": {
      "valid": true,
      "errors": [],
      "warnings": []
    },
    "flowPreview": {
      "nodes": [],
      "edges": []
    },
    "usage": {
      "inputTokens": 1210,
      "outputTokens": 830,
      "costUsd": 0.04
    }
  },
  "message": "Workflow draft generated",
  "meta": null
}
```

## Chat Session Response

```json
{
  "success": true,
  "data": {
    "id": "chat_001",
    "title": "Invoice exception resolver",
    "createdAt": "2026-05-02T09:10:00Z",
    "updatedAt": "2026-05-02T09:18:00Z",
    "messageCount": 3
  },
  "message": "OK",
  "meta": null
}
```

## Send Message Request

```json
{
  "message": "Add a human approval step for high value invoices.",
  "model": "gpt-5.4",
  "mode": "strict-yaml",
  "workflowId": "wf-101"
}
```

## Send Message Response

```json
{
  "success": true,
  "data": {
    "userMessage": {
      "id": "msg_101",
      "role": "user",
      "text": "Add a human approval step for high value invoices.",
      "createdAt": "2026-05-02T09:18:00Z"
    },
    "assistantMessage": {
      "id": "msg_102",
      "role": "assistant",
      "text": "I added a policy approval branch and updated the YAML preview.",
      "createdAt": "2026-05-02T09:18:04Z"
    },
    "artifacts": {
      "yaml": "name: invoice_exception_resolver\nsteps:\n  - id: approval_gate",
      "flowPreview": {
        "nodes": [],
        "edges": []
      }
    }
  },
  "message": "Message processed",
  "meta": null
}
```


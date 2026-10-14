# Notifications and Upload API

Base paths: `/api/notifications`, `/api/upload`

## Notification Endpoints

| Method | Endpoint | Auth | Request / Query | Success Response |
|---|---|---|---|---|
| `GET` | `/notifications` | Required | `page`, `limit`, `unreadOnly` | `Notification[]` |
| `PATCH` | `/notifications/:id/read` | Required | none | `Notification` |
| `PATCH` | `/notifications/read-all` | Required | none | `{ "updated": true }` |
| `DELETE` | `/notifications/:id` | Required | none | `{ "deleted": true }` |

## Upload Endpoints

| Method | Endpoint | Auth | Request Body | Success Response |
|---|---|---|---|---|
| `POST` | `/upload` | Required | `multipart/form-data` | `UploadedFile` |
| `GET` | `/upload/:id` | Required | none | `UploadedFile` |
| `DELETE` | `/upload/:id` | Required | none | `{ "deleted": true }` |
| `POST` | `/upload/workflow-import` | Required | `multipart/form-data` or `{ "yaml": "..." }` | `WorkflowImportResult` |

## Notification Response

```json
{
  "success": true,
  "data": {
    "id": "not_001",
    "message": "ERP connector token expires soon",
    "tone": "warning",
    "type": "integration.warning",
    "read": false,
    "resource": {
      "type": "integration",
      "id": "int_erp_sandbox"
    },
    "createdAt": "2026-05-02T09:50:00Z"
  },
  "message": "OK",
  "meta": null
}
```

## Upload Response

```json
{
  "success": true,
  "data": {
    "id": "file_001",
    "name": "invoice-workflow.yaml",
    "mimeType": "application/x-yaml",
    "sizeBytes": 4096,
    "url": "/api/upload/file_001/download",
    "checksum": "sha256:1f4c...",
    "createdAt": "2026-05-02T09:55:00Z"
  },
  "message": "Upload complete",
  "meta": null
}
```

## Workflow Import Response

```json
{
  "success": true,
  "data": {
    "workflow": {
      "id": "wf-201",
      "name": "Imported Invoice Workflow",
      "status": "PENDING"
    },
    "validation": {
      "valid": true,
      "errors": [],
      "warnings": []
    }
  },
  "message": "Workflow imported",
  "meta": null
}
```


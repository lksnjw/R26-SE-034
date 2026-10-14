# Users, RBAC, and Audit API

Base paths: `/api/users`, `/api/roles`, `/api/permissions`, `/api/audit`

## User Endpoints

| Method | Endpoint | Auth | Request / Query | Success Response |
|---|---|---|---|---|
| `GET` | `/users` | Required | `page`, `limit`, `q`, `role`, `status` | `User[]` |
| `POST` | `/users` | Required | `CreateUserRequest` | `User` |
| `GET` | `/users/:id` | Required | none | `UserDetail` |
| `PATCH` | `/users/:id` | Required | `UpdateUserRequest` | `User` |
| `DELETE` | `/users/:id` | Required | none | `{ "deleted": true }` |
| `POST` | `/users/invite` | Required | `InviteUserRequest` | `InviteResult` |
| `POST` | `/users/:id/activate` | Required | none | `User` |
| `POST` | `/users/:id/suspend` | Required | `{ "reason": "..." }` | `User` |

## Role and Permission Endpoints

| Method | Endpoint | Auth | Request / Query | Success Response |
|---|---|---|---|---|
| `GET` | `/roles` | Required | none | `Role[]` |
| `POST` | `/roles` | Required | `CreateRoleRequest` | `Role` |
| `GET` | `/roles/:id` | Required | none | `Role` |
| `PATCH` | `/roles/:id` | Required | `UpdateRoleRequest` | `Role` |
| `DELETE` | `/roles/:id` | Required | none | `{ "deleted": true }` |
| `GET` | `/permissions` | Required | none | `Permission[]` |
| `GET` | `/permissions/matrix` | Required | none | `PermissionMatrix` |

## Audit Endpoints

| Method | Endpoint | Auth | Request / Query | Success Response |
|---|---|---|---|---|
| `GET` | `/audit` | Required | `page`, `limit`, `actorId`, `action`, `resourceType`, `from`, `to` | `AuditLog[]` |
| `GET` | `/audit/:id` | Required | none | `AuditLog` |
| `GET` | `/audit/export` | Required | filters + `format=csv/json` | File download |

## User Response

```json
{
  "success": true,
  "data": {
    "id": "usr_001",
    "name": "Lakshan Jay",
    "email": "admin@workflow.local",
    "role": {
      "id": "role_admin",
      "name": "Platform Admin"
    },
    "permissions": [
      "workflow:read",
      "workflow:write",
      "workflow:run",
      "user:manage",
      "settings:manage",
      "audit:read"
    ],
    "status": "Active",
    "initials": "LJ",
    "lastLoginAt": "2026-05-02T08:50:00Z",
    "createdAt": "2026-05-01T08:00:00Z"
  },
  "message": "OK",
  "meta": null
}
```

## Invite User Request

```json
{
  "email": "builder@workflow.local",
  "roleId": "role_builder",
  "message": "Please join the workflow platform."
}
```

## Permission Matrix Response

```json
{
  "success": true,
  "data": [
    {
      "role": "Platform Admin",
      "permissions": {
        "workflow:read": true,
        "workflow:write": true,
        "workflow:run": true,
        "user:manage": true,
        "settings:manage": true,
        "audit:read": true
      }
    }
  ],
  "message": "OK",
  "meta": null
}
```

## Audit Log Response

```json
{
  "success": true,
  "data": {
    "id": "audit_001",
    "actor": {
      "id": "usr_001",
      "name": "Lakshan Jay"
    },
    "action": "settings.llm.updated",
    "resource": {
      "type": "settings",
      "id": "llm"
    },
    "ipAddress": "127.0.0.1",
    "userAgent": "Mozilla/5.0",
    "before": {
      "model": "gpt-5.4-mini"
    },
    "after": {
      "model": "gpt-5.4"
    },
    "createdAt": "2026-05-02T09:30:00Z"
  },
  "message": "OK",
  "meta": null
}
```


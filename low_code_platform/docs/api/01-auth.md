# Auth API

Base path: `/api/auth`

## Endpoints

| Method | Endpoint | Auth | Request Body | Success Response |
|---|---|---|---|---|
| `POST` | `/auth/login` | Public | `LoginRequest` | `AuthSession` |
| `POST` | `/auth/register` | Public | `RegisterRequest` | `AuthSession` |
| `POST` | `/auth/logout` | Required | none | `{ "loggedOut": true }` |
| `POST` | `/auth/refresh` | Public | `{ "refreshToken": "..." }` | `TokenPair` |
| `GET` | `/auth/me` | Required | none | `User` |
| `POST` | `/auth/forgot-password` | Public | `{ "email": "admin@example.com" }` | `{ "sent": true }` |
| `POST` | `/auth/reset-password` | Public | `ResetPasswordRequest` | `{ "reset": true }` |
| `POST` | `/auth/verify-email` | Public | `{ "token": "..." }` | `{ "verified": true }` |
| `POST` | `/auth/2fa/verify` | Required | `{ "code": "123456" }` | `{ "verified": true }` |
| `POST` | `/auth/2fa/enable` | Required | `{ "code": "123456" }` | `{ "enabled": true }` |
| `POST` | `/auth/2fa/disable` | Required | `{ "password": "..." }` | `{ "enabled": false }` |
| `GET` | `/auth/oauth/:provider/authorize` | Public | none | Redirect URL |
| `GET` | `/auth/oauth/:provider/callback` | Public | query params | `AuthSession` |

Supported OAuth providers: `google`, `github`.

## Login Request

```json
{
  "email": "admin@workflow.local",
  "password": "Password123!",
  "rememberMe": true
}
```

## Register Request

```json
{
  "name": "Lakshan Jay",
  "email": "admin@workflow.local",
  "password": "Password123!",
  "organizationName": "Workflow Research Lab"
}
```

## Reset Password Request

```json
{
  "token": "reset-token",
  "password": "NewPassword123!"
}
```

## Auth Session Response

```json
{
  "success": true,
  "data": {
    "accessToken": "jwt-access-token",
    "refreshToken": "jwt-refresh-token",
    "expiresIn": 3600,
    "user": {
      "id": "usr_001",
      "name": "Lakshan Jay",
      "email": "admin@workflow.local",
      "role": "Platform Admin",
      "permissions": [
        "workflow:read",
        "workflow:write",
        "workflow:run",
        "settings:manage",
        "user:manage",
        "audit:read"
      ],
      "twoFactorEnabled": true,
      "emailVerified": true
    }
  },
  "message": "Login successful",
  "meta": null
}
```

## Token Pair Response

```json
{
  "success": true,
  "data": {
    "accessToken": "new-jwt-access-token",
    "refreshToken": "new-jwt-refresh-token",
    "expiresIn": 3600
  },
  "message": "Token refreshed",
  "meta": null
}
```


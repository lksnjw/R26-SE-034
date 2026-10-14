# Realtime and reconnect APIs

## Authoritative execution progress

Execution progress uses the normal authenticated HTTP API, not the WebSocket
route:

```http
GET /api/executions/:id/events?after=17&limit=100&waitMs=25000
Authorization: Bearer <access-token>
```

`after` is the last contiguous event sequence held by the client. `limit` is
between 1 and 100. `waitMs` is optional and bounded from 0 through 25,000 ms.
When there is no newer event and the run is active, the server may hold the
request until a relevant acknowledged repository commit or the timeout. A held
request never runs, retries, resumes, cancels, or dispatches ERP work.

The response is a saved evidence page:

```json
{
  "success": true,
  "data": {
    "events": [],
    "cursor": 17,
    "lastSequence": 17,
    "hasMore": false,
    "status": "RUNNING",
    "profile": "read-progress-v1",
    "waited": true,
    "waitedMs": 25001
  }
}
```

The server reapplies account, permission, execution-scope, cursor, and storage
authority checks after every wake-up. Authorization loss returns not-found and
does not return earlier evidence. Storage authority loss returns 503 without
claiming a status. The browser drains `hasMore` pages immediately, verifies
contiguous sequences and execution IDs, reloads the authoritative execution and
timeline when evidence advances, and backs off after transport failures. It
never responds to a display failure by resubmitting the workflow.

This is authenticated long polling with durable cursor replay. It provides
low-delay local commit visibility without putting bearer tokens in URLs. It is
not Server-Sent Events, WebSocket execution streaming, model-token streaming,
or proof of a cloud/network latency SLO.

## WebSocket boundary

`GET /ws/*` currently authenticates the handshake and emits one
`system.health.snapshot` every five seconds. The requested wildcard is echoed as
the `data.channel` label, but it does not change the payload and does not provide
execution logs, execution status, canvas collaboration, or notification events.
No frontend product component depends on this socket.

Browser WebSocket clients cannot set an `Authorization` header. Although the
legacy handshake accepts `?token=`, applications must not use bearer tokens in
URLs because browser history, proxies, and access logs can expose them. A future
WebSocket product transport requires a separately issued short-lived,
audience-scoped ticket plus channel authorization, replay cursors, gap recovery,
backpressure, reconnect tests, and token/log redaction.

## Separate ERPBridge streams

ERPBridge MCP transport and its notification/SSE handling are backend-to-bridge
protocol surfaces. They are not browser execution progress and do not replace
the saved application event journal. Changing that upstream transport cannot by
itself prove faster UI updates or safe replay.

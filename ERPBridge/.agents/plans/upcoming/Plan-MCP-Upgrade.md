# Plan: MCP Specification Upgrade — Deferred

## Status

Upcoming and deferred. No implementation is authorized by this file. The
hardening and AuthN/AuthZ plans are complete; refresh this plan with current
protocol and dependency evidence before creating a new finalized execution
plan.

## Goal

Evaluate and, if justified, migrate ERPBridge from `mcp-go v0.57.0` to a release supporting the target MCP specification. The upgrade must not invalidate the active plans’ HTTP CORS/authentication or Stdio tool-filtering assumptions without replacement integration tests.

## Preconditions

- `../completed/[COMPLETED]Plan-main.md` is complete, including Stdio wire-format coverage.
- `../completed/[COMPLETED]AuthN-AuthZ-Plan.md` is complete, including MCP transport CORS, authentication, and authorization tests.
- A current upstream release and migration guide are evaluated against the deployed protocol version.

## Scope

No implementation work is authorized by this plan today. When reprioritized, create a fresh evidence-backed migration plan rather than editing active hardening/auth tasks.

# Monorepo Component Layout Plan

## Goal

Relocate the complete ERPBridge project beneath an `ERPBridge/` component
directory so it can coexist with the other research components in the shared
repository without path collisions or history rewriting.

## Approved scope

The repository owner requested this component relocation and the subsequent
history-preserving merge on 2026-10-14. No application behavior or existing
file content was changed.

## Task

- [x] Move every tracked ERPBridge path beneath `ERPBridge/` in one atomic
      commit while preserving blob contents, file modes, and all ancestor
      commits.

## Verification

- The pre-move root and post-move `ERPBridge/` subtree contain the same 183
  tracked entries with zero mode, blob-ID, or relative-path differences.
- `make test` could not start because GNU Make is not installed on the Windows
  host.
- The direct fallback `go test ./...` ran. All packages except `internal/mcp`
  passed; that package reported Windows file-lock/read-only-permission behavior
  in `TestServer_HandleToolDelete` and `TestStore_NewStore_Errors`.
- A clean working tree is required after the relocation commit.

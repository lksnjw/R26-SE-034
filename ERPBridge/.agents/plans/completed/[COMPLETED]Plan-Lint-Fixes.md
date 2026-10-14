# Plan: Fix All golangci-lint Issues

## Objective
Fix all 119 `golangci-lint` issues (revive, goconst, gosec, gocritic, whitespace) across the repository in small, grouped atomic commits without breaking any existing behavior or tests.

## Tasks

- [x] **Task 1: Fix lint issues in `internal/banner`, `internal/metrics`, `internal/output`**
  - Fix revive package/doc comments in `internal/banner`
  - Fix goconst in `internal/metrics` and `internal/output`
  - Verify: `golangci-lint run ./internal/banner/... ./internal/metrics/... ./internal/output/... && go test ./internal/banner/... ./internal/metrics/... ./internal/output/...`

- [x] **Task 2: Fix lint issues in `internal/logger` and `internal/types`**
  - Fix revive package comments & exported func comments in `internal/logger` & `internal/types`
  - Fix whitespace in `internal/logger/mcp_handler_test.go`
  - Verify: `golangci-lint run ./internal/logger/... ./internal/types/... && go test ./internal/logger/... ./internal/types/...`

- [x] **Task 3: Fix lint issues in `internal/config` and `internal/connector`**
  - Fix revive package & type comments, goconst, and gosec G304 in `internal/config`
  - Fix goconst in `internal/connector`
  - Verify: `golangci-lint run ./internal/config/... ./internal/connector/... && go test ./internal/config/... ./internal/connector/...`

- [x] **Task 4: Fix lint issues in `internal/cache`**
  - Fix revive doc comments & unused parameter naming in `internal/cache`
  - Fix goconst in `internal/cache`
  - Verify: `golangci-lint run ./internal/cache/... && go test ./internal/cache/...`

- [x] **Task 5: Fix lint issues in `internal/idp`**
  - Fix revive doc comments in `internal/idp`
  - Fix gocritic assignOp, gosec file/dir permissions (0750, 0600) and false-positive G101 annotations in `internal/idp`
  - Fix goconst in `internal/idp`
  - Verify: `golangci-lint run ./internal/idp/... && go test ./internal/idp/...`

- [x] **Task 6: Fix lint issues in `internal/cli`**
  - Fix revive package comments, unused parameters, doc comments in `internal/cli`
  - Fix goconst in `internal/cli`
  - Verify: `golangci-lint run ./internal/cli/... && go test ./internal/cli/...`

- [x] **Task 7: Fix lint issues in `internal/mcp`**
  - Fix gocritic switch & elseif statements in `internal/mcp`
  - Fix goconst and unused parameters in `internal/mcp`
  - Verify: `golangci-lint run ./internal/mcp/... && go test ./internal/mcp/...`

- [x] **Task 8: Fix lint issues in `services/erpbridge-server`**
  - Fix gosec G114 by configuring timeouts on `http.Server`
  - Verify: `golangci-lint run ./services/erpbridge-server/... && go test ./services/erpbridge-server/...`

- [x] **Task 9: Full Verification & Cleanup**
  - Verify: `golangci-lint run ./... && go test ./...`

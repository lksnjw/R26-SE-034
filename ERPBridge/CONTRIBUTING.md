# Contributing to ERPBridge

Thank you for contributing. This guide explains how to report bugs, request features, and submit code.

## Code of Conduct

Be respectful. Assume that other contributors act in good faith.

## Reporting Bugs

1. Search the [existing issues](https://github.com/nmdra/ERPBridge/issues) first. Your bug may already be reported.
2. Open a new issue with the bug report template.
3. Include:
   - The `bridgectl` or server version (`bridgectl version`)
   - Your operating system and Go version
   - The full error message and log output
   - Steps to reproduce the bug
   - What you expected to happen

## Requesting Features

Open an issue with the feature request template. Describe the problem you want to solve. Do not describe the solution only.

## Submitting Code

### Prerequisites

- Go 1.26.2+
- `golangci-lint`
- `lefthook` (installed via `go run github.com/evilmartians/lefthook/v2@latest install`)

### Workflow

1. Fork the repository.
2. Create a branch with a descriptive name.
3. Make your changes.
4. Run the checks:
   ```bash
   make test
   make lint
   ```
5. Commit with a message in the Conventional Commits format. For example:
   ```
   feat(cli): add tool export command
   fix(server): handle empty tool name on delete
   docs: correct stdio transport instructions
   ```
6. Push the branch and open a pull request.

### Before You Open a Pull Request

- Keep the change small and focused.
- Add tests for new behavior.
- Update the CLI reference when you change a command or flag:
  ```bash
  bridgectl doc
  ```
- Add a `CHANGELOG.md` entry under `[Unreleased]`.
- Make sure that all tests pass and the linter reports no issues.

## Development Setup

```bash
make setup
```

Start the mock ERP and server:

```bash
make run-mock
make run-server
```

## Documentation

Documentation lives in `docs/`. Follow these rules:

- Write short sentences. One instruction per sentence.
- Use `make sure that` for the check/verify/confirm/validate family.
- Put a condition before the command it guards.
- Do not use `should` in instructions. Use `must` for requirements.
- Verify every command against the implementation before you add it.

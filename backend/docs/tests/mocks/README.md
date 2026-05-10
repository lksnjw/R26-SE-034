# Test Mocks

Test mocks are located in `tests/mocks/` and provide mock implementations of external services.

## Files

- **`mcp_mock.go`**: Provides a mock `MCPClient` for testing tools that use the Model Context Protocol. It allows simulating tool execution without a running MCP server.

## Role

Mocks are used to decouple the test suite from external infrastructure. This ensures that tests are fast, do not require network access, and are not subject to the rate limits or availability of external LLM/Search providers.

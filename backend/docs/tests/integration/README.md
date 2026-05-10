# Integration Tests

Integration tests are located in `tests/integration/` and verify the end-to-end functionality of the system.

## Files

- **`api_test.go`**: Tests the `/api/chat/sessions/:sessionID/messages` endpoint. It simulates a full user interaction:
    1.  User sends a natural language request.
    2.  The system performs semantic search (mocked embedding service).
    3.  The system generates workflow candidates (mocked Gemini service).
    4.  The system validates candidates against the registry.
    5.  The system selects and returns the best candidate.

## Testing Strategy

The integration tests ensure that all internal components (Semantic Search, Synthesizer, Validator, Orchestrator) work together correctly within the Fiber web framework. External dependencies are mocked at the HTTP layer to ensure tests are deterministic and can run in CI environments without external API keys.

# Unit Tests

Unit tests are located in `tests/unit/` and focus on validating individual components and their logic.

## Files

- **`validator_test.go`**: Tests the basic `WorkflowValidator`. It ensures that the YAML-based semantic gate correctly identifies safe and unsafe actions (e.g., blocking `drop_database`).
- **`runner_test.go`**: Tests the `Executor` component. It verifies that tools registered in the `Registry` are correctly executed and that the runner handles workflow steps as defined in the blueprint.
- **`synthesizer_test.go`**: Verifies the `Synthesizer` service. It ensures that the LLM integration (or fallback) correctly generates workflow YAML from natural language.
- **`pipeline_test.go`**: A major test suite covering the entire orchestration pipeline:
    - **Dataset Loader**: Validates the loading of tools, rules, templates, and examples from the registry files.
    - **Semantic Search**: Tests both `go_lexical` and `external_embedding` retrieval methods.
    - **Prompt Building**: Ensures the LLM prompt is correctly constructed with retrieved context and few-shot examples.
    - **Registry Validation**: Extensive tests for hallucinated tools, missing parameters, RBAC violations, and process order violations.
    - **Orchestration**: Tests the `ChatOrchestrator`'s ability to handle chat messages and coordinate the generation/validation flow.
- **`validator_accuracy_test.go`**: A specialized test for evaluating the validator's performance. It runs thousands of test cases (both from fixtures and generated) and produces detailed accuracy reports (HTML, JSON) and SVG charts.
- **`semantic_and_generation_accuracy_test.go`**: Measures the accuracy of semantic search (using Mean Reciprocal Rank) and the quality of LLM generation against expected outcomes.
- **`accuracy_dashboard_test.go`**: Aggregates accuracy metrics into a visual dashboard.

## Testing Strategy

The unit testing strategy relies on:
1.  **Isolation**: Mocking external services (like Gemini or the embedding server) using `httptest`.
2.  **Dataset Fixtures**: Using the actual production registries (`all_tools_master_registry.json`) to ensure tests reflect real-world constraints.
3.  **Quantitative Evaluation**: Using large-scale generation and validation tests to ensure high accuracy (>95% for static cases, >85% for generated long flows).

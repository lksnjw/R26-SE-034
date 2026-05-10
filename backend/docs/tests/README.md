# Testing Documentation

This directory provides a comprehensive overview of the testing suite for the Low-Code Workflow Engine. The tests are designed to ensure the reliability, security, and accuracy of the orchestrator's core components, from individual units to full API integration.

## Directory Structure

- [**Unit Tests**](./unit/README.md) (`tests/unit/`): Component-level tests and accuracy evaluations.
- [**Integration Tests**](./integration/README.md) (`tests/integration/`): End-to-end API and system tests.
- [**Test Fixtures**](./fixtures/README.md) (`tests/fixtures/`): Static test data and scenarios.
- [**Test Mocks**](./mocks/README.md) (`tests/mocks/`): Mock implementations for external services.

---

## Testing Strategy Overview

The system employs a multi-layered testing strategy:

1.  **Functional Unit Testing**: Ensuring individual components like the `Validator`, `Synthesizer`, and `Runner` behave correctly according to their specifications.
2.  **Pipeline Orchestration Testing**: Verifying the complex interactions between semantic search, LLM generation, and registry-based validation.
3.  **Quantitative Accuracy Evaluation**: Using statistical metrics (Accuracy, F1, MRR) to measure the effectiveness of the AI-driven components against large-scale datasets.
4.  **End-to-End API Integration**: Validating the full system flow from HTTP request to workflow selection using mocked external AI services.

# Synthesizer

The `synthesizer` directory handles the conversion of natural language requests into structured workflow candidates using Large Language Models (LLMs).

## Key Files

### `candidates.go` (LLM Prompt Engineering)

This file contains the core logic for generating workflow candidates. It performs:
-   **Prompt Engineering**: Constructs a comprehensive system prompt that includes executable tools, missing schema tools, future capabilities, governance rules, and few-shot examples.
-   **Strict Enforcement**: Instructs the LLM to only use executable tools and follow specific governance rules (e.g., procurement process order).
-   **Candidate Parsing**: Parses the LLM's response, which can be in JSON or a custom separator-based format, into `WorkflowCandidate` objects.
-   **Fallback Generation**: Provides a deterministic fallback mechanism to generate basic workflows if the LLM fails or returns unparseable content.

### `prompt_gen.go`

Provides the `PromptBuilder` which manages the basic prompt structure and a set of default "skills" or actions that the engine can perform.

### `gemini_client.go` / `ollama_client.go`

These files contain the clients for interacting with different LLM providers (Google Gemini and Ollama). They handle the HTTP requests, API key management (for Gemini), and response decoding.

## Prompt Engineering Logic

The prompt is designed to be highly restrictive and context-rich:
-   **System Role**: Defines the LLM as an "enterprise YAML workflow blueprint generator."
-   **Tool Allowlist**: Explicitly lists tools that *can* be used (executable) and those that *cannot* (missing schema/future), preventing hallucinations.
-   **Governance Injection**: Directly injects relevant rules into the prompt to ensure the LLM considers compliance during generation.
-   **Few-Shot Learning**: Includes similar successful requests and their expected YAML output to guide the LLM's format and logic.
-   **Security Constraints**: Explicitly forbids the inclusion of secrets and the generation of destructive workflows.

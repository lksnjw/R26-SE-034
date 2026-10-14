# Orchestrator

The `orchestrator` directory contains the core brain of the Agentic Workflow Engine. It coordinates the retrieval of context, safety checks, domain detection, and the synthesis of workflow candidates.

## Key Files

### `chat_orchestrator.go` (The Brain)

`ChatOrchestrator` is the central coordinator for processing natural language requests. It manages the following pipeline:

1.  **Retrieval**: Uses `semanticsearch` to find relevant tools, governance rules, process templates, and few-shot examples based on the user's request.
2.  **Safety Check**: Performs early blocking of destructive identity or administrator actions (e.g., requests to delete users or roles) before any workflow is generated.
3.  **Domain Detection**: Identifies the business domain (e.g., Procurement, Finance, HR) to filter relevant tools and rules.
4.  **Tool Backfilling**: Ensures that essential executable tools are available in the context even if not explicitly retrieved by the semantic search.
5.  **Status Splitting**: Categorizes retrieved tools into executable, missing schema (mock), or future capabilities.
6.  **Prompt Building**: Consolidates all retrieved context into a structured prompt for the LLM.
7.  **Candidate Generation**: Calls the `synthesizer` to generate multiple workflow candidates.
8.  **Validation**: Passes each candidate through the `validator` to check for schema correctness, tool validity, RBAC, and governance policy compliance.
9.  **Selection**: Uses the `CandidateSelector` to pick the best valid candidate based on score, risk, and complexity.

### `candidate_selector.go`

Responsible for selecting the "best" candidate from the validated options. It uses a ranking logic that considers:
-   **Validation Score**: Higher scores are preferred.
-   **Estimated Risk**: Lower risk levels (Low < Medium < High < Critical) are preferred.
-   **Step Count**: Simpler workflows (fewer steps) are preferred for identical scores and risks.

### `orchestration_models.go`

Defines the data structures used for communication between the API handlers and the orchestrator, including `ChatRequest`, `ChatResponse`, and `CandidateReport`.

### `terminal_reporter.go`

Provides utility functions for displaying orchestration results in a human-readable format, primarily used for logging and debugging.

## Logic Flow in `HandleChatMessage`

```go
// 1. Context Retrieval
retrieval, err := o.Search.SearchContext(...)

// 2. Early Safety Gate
if blocked, errors := destructiveIdentityRequestErrors(req.UserText); blocked {
    return ChatResponse{...}, nil
}

// 3. Domain Detection & Tool Preparation
domain := detectRequestDomain(...)
executableTools, schemaMissingTools, futureCapabilities := splitToolsByStatus(...)

// 4. Candidate Generation
candidates, err := o.Generator.GenerateCandidates(...)

// 5. Validation Loop
for _, candidate := range candidates {
    validation := o.Validator.ValidateCandidate(...)
    reports = append(reports, CandidateReport{...})
}

// 6. Best Candidate Selection
selected, ok := o.Selector.Select(reports)
```

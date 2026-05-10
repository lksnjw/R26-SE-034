# Validator

The `validator` directory provides the governance and safety layer for the workflow engine. It ensures that every generated workflow candidate is safe, compliant, and executable.

## Key Files

### `registry_validator.go` (Governance/Safety)

The `RegistryValidator` is the primary validation engine. It performs exhaustive checks on each workflow candidate:

-   **Schema Validation**: Ensures the YAML follows the required structure (Trigger, Steps, Actions, Parameters).
-   **Tool Validity**: Verifies that every action in the workflow exists in the `ToolRegistry` and has an executable status (`active_mcp_schema_present`).
-   **Parameter Completeness**: Checks that all required parameters for each tool are provided in the step configuration.
-   **RBAC (Role-Based Access Control)**: Validates that the user role requesting the workflow has permission to execute each tool.
-   **Governance Rule Evaluation**: Dynamically evaluates a set of enabled rules from the `RuleRegistry`. Supported rule types include:
    -   `rbac`: Additional role-based restrictions.
    -   `parameter_required`: Enforces the presence of specific parameters for certain tools.
    -   `threshold`: Checks numeric parameters against defined limits (e.g., amount > 1000) and may require human approval.
    -   `process_order`: Ensures a specific sequence of tools (e.g., `validate_vendor` before `create_purchase_order`).
    -   `separation_of_duties`: Ensures different actors for sensitive steps (e.g., requester != approver).
    -   `risk_escalation`: Identifies high-risk workflows and ensures they include approval steps.
    -   `audit`: Ensures high-risk or write operations are logged.

### `schema_check.go`

Provides basic YAML structural validation using standard JSON/YAML schema patterns and Go struct tags.

### `semantic_gate.go`

An additional safety layer that blocks common high-risk patterns, such as direct database/SQL access, ensuring that only registered MCP bridge tools are used.

## Scoring Logic

The validator assigns a score (0.0 to 1.0) to each candidate based on its compliance:
-   Schema OK: +0.20
-   Tool Validity OK: +0.20
-   Parameters OK: +0.20
-   RBAC OK: +0.15
-   Policy OK: +0.15
-   Process Order OK: +0.05
-   Risk OK: +0.05

A candidate is only considered "Passed" if it satisfies all critical checks and has no errors.

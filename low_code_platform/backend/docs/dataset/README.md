# Dataset & Knowledge Base

The `dataset/` directory contains the foundational data used to ground the LLM and enforce governance.

## Directory Structure

### `01_tool_registries/`
Contains JSON files defining the available tools (e.g., `hr_tools.json`, `finance_tools.json`). Each tool definition includes its name, description, input parameters (JSON Schema), and required RBAC permissions.

### `02_governance_rules/`
Contains governance and safety rules (e.g., `global_safety_rules.json`, `procurement_rules.json`). These rules define constraints like spending limits, required approvals, and domain-specific policies.

### `03_process_templates/`
Contains BPI-aligned (Business Process Improvement) templates for common workflows. These serve as few-shot examples for the LLM during candidate generation.

### `04_test_scenarios/`
A collection of natural language requests mapped to expected tools and rules. This is used for automated accuracy testing of the search and synthesis pipeline.

### `05_validator_cases/`
Specific edge cases used to test the `Validator`. It includes examples of hallucinated tools, missing parameters, and policy violations.

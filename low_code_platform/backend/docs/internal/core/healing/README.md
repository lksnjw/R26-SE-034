# Self-Healing & Error Handling

The `internal/core/healing` package implements the "Error Loop" logic, allowing the engine to recover from execution failures.

## Error Loop (`error_loop.go`)

When a workflow step fails during execution, the `Healer` is invoked. It follows this process:
1. **Diagnosis**: Analyzes the execution error and the current state.
2. **Repair Prompting**: Constructs a specialized prompt for the LLM that includes:
   - The original user request.
   - The failing workflow blueprint (YAML).
   - The specific error message and step that failed.
   - The current execution state.
3. **Re-Synthesis**: Asks the `Synthesizer` to generate a *corrected* version of the workflow blueprint.
4. **Resumption**: The `Executor` then attempts to continue execution using the repaired blueprint.

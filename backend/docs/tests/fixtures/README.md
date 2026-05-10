# Test Fixtures

Test fixtures are located in `tests/fixtures/` and provide static data for testing.

## Files

- **`validator_accuracy_cases.json`**: A collection of structured test cases for the `RegistryValidator`. Each case includes:
    - `user_role`: The role attempting the action.
    - `yaml_lines`: The workflow YAML to validate.
    - `expected_result`: Whether it should be `PASS` or `BLOCK`.
    - `expected_failed_rules`: The specific rule IDs that should trigger a failure.

## Role

Fixtures provide a "ground truth" for evaluating the system's performance. By using static fixtures, we can ensure that regressions in the validation logic or semantic search are immediately caught during development.

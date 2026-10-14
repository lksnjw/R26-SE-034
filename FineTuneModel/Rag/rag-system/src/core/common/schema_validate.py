"""
JSON-Schema-subset validation, shared by the action registry and /api/assist's
caller-supplied tool specs.

Deliberately a small hand-rolled subset (required / oneOf / type /
additionalProperties) rather than a schema library — these are the constraints
this codebase actually authors, and a failure here must be a clear message the
caller can act on, not a nested validator trace. Extracted from
`intent_extractor.validate_parameters` (which now wraps `validate_against_schema`
unchanged) so /api/assist can validate tool arguments the same way without a
second, drifting copy of the same logic.
"""
from typing import Any


def validate_against_schema(schema: dict[str, Any], params: dict[str, Any]) -> list[str]:
    """
    Check `params` against a JSON-Schema-subset `schema`.

    Mutates `params` in place for the same coercions `intent_extractor` always
    did (numeric strings -> float, non-string -> str for a "string" property) —
    callers that need the coerced values back rely on this.
    """
    problems: list[str] = []
    properties: dict = schema.get("properties", {})

    for key in params:
        if key not in properties and schema.get("additionalProperties") is False:
            problems.append(f"unknown parameter '{key}'")

    for key in schema.get("required", []):
        if key not in params or params[key] in (None, ""):
            problems.append(f"missing required parameter '{key}'")

    one_of = schema.get("oneOf")
    if one_of:
        matched = [
            branch for branch in one_of
            if all(r in params and params[r] not in (None, "") for r in branch.get("required", []))
        ]
        if len(matched) != 1:
            options = " or ".join(
                "+".join(b.get("required", [])) for b in one_of
            )
            problems.append(
                f"exactly one of ({options}) must be supplied, got {len(matched)}"
            )

    for key, value in params.items():
        expected = properties.get(key, {}).get("type")
        if expected == "number" and isinstance(value, str):
            # The model often returns "1450000" for a number field; accept it if
            # it is unambiguously numeric, reject anything needing interpretation.
            try:
                params[key] = float(value.replace(",", ""))
            except ValueError:
                problems.append(f"parameter '{key}' must be a number, got {value!r}")
        elif expected == "string" and not isinstance(value, str):
            params[key] = str(value)

    return problems


def validate_schema_shape(schema: dict[str, Any]) -> list[str]:
    """
    Sanity-check a caller-supplied JSON-Schema-subset itself, before it is ever
    used to validate arguments or shown to a model.

    Action schemas in `action_registry.py` are authored in-repo and trusted; a
    /api/assist `ToolSpec.input_schema` arrives from an external caller and has
    no such guarantee — a malformed schema here should drop that one tool
    (logged), not corrupt validation of every tool call made against it.
    """
    problems: list[str] = []

    if not isinstance(schema, dict):
        return ["input_schema must be a JSON object"]

    properties = schema.get("properties", {})
    if properties and not isinstance(properties, dict):
        problems.append("'properties' must be an object")
        properties = {}

    required = schema.get("required", [])
    if not isinstance(required, list):
        problems.append("'required' must be a list")
        required = []
    else:
        for key in required:
            if key not in properties:
                problems.append(f"'required' names undeclared property '{key}'")

    one_of = schema.get("oneOf")
    if one_of is not None:
        if not isinstance(one_of, list) or not one_of:
            problems.append("'oneOf' must be a non-empty list")
        else:
            for branch in one_of:
                if not isinstance(branch, dict) or not isinstance(branch.get("required"), list):
                    problems.append("each 'oneOf' branch must be an object with a 'required' list")
                    break

    return problems

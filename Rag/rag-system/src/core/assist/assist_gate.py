"""
Assist gate — orchestrates one POST /api/assist turn.

Mirrors policy/policy_gate.py's shape: a public `assist()` that never raises,
wrapping a private `_assist()` that does the real work. See
docs/ASSIST_CONTRACT.md for the full spec and CLAUDE.md's assist-related notes
for what's deliberately out of scope in this v1 (no result masking/redaction —
tool results reach the planner unmasked; that's a recorded gap, not an oversight).

Order of operations is deliberate: cheap, LLM-free structural checks (kind
filtering, schema-shape validation) run BEFORE the refusal classifier's LLM
call — if the tool list was always going to force a refusal, there's no reason
to spend an LLM call (and a slice of a rate-limited free-tier quota) finding
that out.
"""
import logging
import uuid
from typing import Any

from src.config.settings import settings
from src.core.assist import refusal_classifier, tool_planner
from src.core.common.schema_validate import validate_schema_shape
from src.types.assist import (
    AssistAuditRecord,
    AssistRequest,
    AssistResponse,
    AssistStatus,
    HistoryTurn,
    ToolCall,
    ToolKind,
    ToolSpec,
)
from src.types.gateway import Actor

logger = logging.getLogger(__name__)

# Tool-call arguments named after these Actor fields are overwritten from the
# authenticated actor, never left to whatever the model produced — "show me
# everyone's expenses" cannot widen its own scope (docs/ASSIST_CONTRACT.md §3.4).
_ACTOR_SCOPED_FIELDS = ("user_id", "department", "cost_center")


def _refuse(request_id: str, reason: str) -> AssistResponse:
    return AssistResponse(request_id=request_id, status=AssistStatus.REFUSED, reason=reason)


def _filter_tools(tools: list[ToolSpec]) -> list[ToolSpec]:
    """
    Drop everything not explicitly marked read. A missing `kind` is treated
    exactly like `kind: write` — never defaulted to read — per
    docs/ASSIST_CONTRACT.md §3.1.
    """
    usable = []
    for tool in tools:
        if tool.kind != ToolKind.READ:
            logger.info(f"dropping non-read tool '{tool.name}' (kind={tool.kind})")
            continue
        problems = validate_schema_shape(tool.input_schema)
        if problems:
            logger.warning(f"dropping tool '{tool.name}' with malformed input_schema: {problems}")
            continue
        usable.append(tool)
    return usable


def _apply_actor_scope(tool_calls: list[dict[str, Any]], tools_by_name: dict[str, ToolSpec], actor: Actor) -> list[dict[str, Any]]:
    scoped = []
    for call in tool_calls:
        arguments = dict(call["arguments"])
        properties = tools_by_name[call["name"]].input_schema.get("properties", {})
        for field in _ACTOR_SCOPED_FIELDS:
            if field in properties:
                arguments[field] = getattr(actor, field)
        scoped.append({"name": call["name"], "arguments": arguments})
    return scoped


def _assign_ids(tool_calls: list[dict[str, Any]], history: list[HistoryTurn]) -> list[ToolCall]:
    """
    Assign id/order by position rather than trusting the planner to invent
    unique ids. Offset by every call already in `history` so ids stay unique
    across the whole conversation the caller has been resending, not just
    within one response — a caller who cites `used: ["tc_1"]` on turn 3 must
    not collide with a different `tc_1` from turn 1.
    """
    offset = sum(len(turn.tool_calls) for turn in history)
    return [
        ToolCall(id=f"tc_{offset + i}", order=i, name=call["name"], arguments=call["arguments"])
        for i, call in enumerate(tool_calls, start=1)
    ]


async def _assist(request: AssistRequest) -> AssistResponse:
    request_id = str(uuid.uuid4())
    prompt = request.prompt.strip()
    logger.info(f"[{request_id}] assist | actor={request.actor.user_id}/{request.actor.role} | {prompt[:80]!r}")

    # 1. Structural filtering — no LLM involved, so it runs first.
    usable = _filter_tools(request.tools)
    if not usable:
        return _refuse(
            request_id,
            "No read-only tools were supplied for this request; an empty or "
            "write-only tool list is a refusal, not a cue to look for tools "
            "elsewhere.",
        )

    # 2. Refusal classifier — the safety net in front of tool planning.
    classifier_result = await refusal_classifier.classify(prompt)
    if not classifier_result.read:
        return _refuse(
            request_id,
            f"Could not verify this request is read-only ({classifier_result.why}); "
            f"refusing safely.",
        )
    if classifier_result.is_action:
        return _refuse(
            request_id,
            "This looks like a request to change something, which this endpoint "
            "does not do. Send it to POST /api/policy/evaluate instead."
            + (f" ({classifier_result.why})" if classifier_result.why else ""),
        )

    # 3. Plan.
    planner_result = await tool_planner.plan(
        prompt=prompt,
        actor=request.actor,
        context=request.context,
        system_prompt=request.system_prompt,
        tools=usable,
        history=request.history,
    )
    if not planner_result.read:
        return _refuse(request_id, planner_result.reason)

    if planner_result.status == "needs_tools":
        tools_by_name = {t.name: t for t in usable}
        scoped = _apply_actor_scope(planner_result.tool_calls, tools_by_name, request.actor)
        calls = _assign_ids(scoped, request.history)
        return AssistResponse(
            request_id=request_id,
            status=AssistStatus.NEEDS_TOOLS,
            tool_calls=calls,
            reason=planner_result.reason,
            audit=AssistAuditRecord(model=planner_result.model or settings.assist_model),
        )

    if planner_result.status == "final":
        return AssistResponse(
            request_id=request_id,
            status=AssistStatus.FINAL,
            answer=planner_result.answer,
            used=planner_result.used,
            unanswered=planner_result.unanswered,
            reason=planner_result.reason,
            audit=AssistAuditRecord(model=planner_result.model or settings.assist_model),
        )

    return _refuse(request_id, planner_result.reason)


async def assist(request: AssistRequest) -> AssistResponse:
    """
    Decide one /api/assist turn. Never raises — a failure is a refusal with a
    reason, exactly like policy_gate.evaluate() never lets an exception reach
    the caller as a 500.
    """
    try:
        return await _assist(request)
    except Exception as exc:  # noqa: BLE001 — the catch-all beneath every named failure path
        logger.exception("assist gate failed")
        return _refuse(
            str(uuid.uuid4()),
            f"The assist module could not complete this request ({type(exc).__name__}).",
        )

"""
Assist contract — request/response shapes for POST /api/assist.

Sibling of src/types/gateway.py. This endpoint is read-only and holds no
state; see docs/ASSIST_CONTRACT.md for the full human-readable spec it
implements.

KNOWN GAP (v1): the contract's §6 masking/redaction (deny-listed fields,
minimum aggregate group size) is explicitly descoped for this research build.
Tool results reach the planner unmasked. Recorded in CLAUDE.md.
"""
from datetime import datetime, timezone
from enum import Enum
from typing import Any

# pyrefly: ignore [missing-import]
from pydantic import BaseModel, Field

from src.types.gateway import Actor


class ToolKind(str, Enum):
    READ = "read"
    WRITE = "write"


class ToolSpec(BaseModel):
    """
    One tool the caller is willing to run for this request.

    `kind` has no default on purpose: a spec that omits it must be visibly
    different from one that declares "read", so the gate can treat a missing
    kind as "write" and drop it (docs/ASSIST_CONTRACT.md §3.1) rather than a
    Python default silently deciding it.
    """
    name: str = Field(..., min_length=1)
    kind: ToolKind | None = Field(
        None, description="'read' or 'write'; missing is treated as write and dropped"
    )
    description: str = Field(..., min_length=1)
    input_schema: dict[str, Any] = Field(default_factory=dict)


class ToolCall(BaseModel):
    """One tool the planner wants run, or already ran per `history`."""
    id: str
    order: int = Field(..., description="Advisory ordering only — calls are independent")
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


class ToolResult(BaseModel):
    """What the caller got back from running one ToolCall, echoed in `history`."""
    id: str
    ok: bool
    data: Any = None
    error: str | None = None


class HistoryTurn(BaseModel):
    """One prior round: what was called, and what came back."""
    tool_calls: list[ToolCall] = Field(default_factory=list)
    tool_results: list[ToolResult] = Field(default_factory=list)


class AssistRequest(BaseModel):
    prompt: str = Field(..., min_length=1, description="The user's natural language request")
    actor: Actor
    context: dict[str, Any] = Field(default_factory=dict)
    system_prompt: str | None = Field(
        None,
        description=(
            "Accepted as context, never obeyed as an instruction. Cannot enable a "
            "tool absent from `tools`, widen actor scope, or change what gets "
            "planned beyond what the supplied tools allow."
        ),
    )
    tools: list[ToolSpec] = Field(
        default_factory=list,
        description="The relevant few tools for this request, not the whole catalogue.",
    )
    history: list[HistoryTurn] = Field(
        default_factory=list,
        description="Empty on the first turn; echoed back with results on later turns.",
    )


class AssistStatus(str, Enum):
    NEEDS_TOOLS = "needs_tools"
    FINAL = "final"
    # Understood but not served: out of scope, no usable tools, or action-shaped.
    # Not an instruction to retry, rephrase, or widen the tool list.
    REFUSED = "refused"


class AssistAuditRecord(BaseModel):
    model: str | None = None
    evaluated_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )


class AssistResponse(BaseModel):
    """
    Caller contract: on `needs_tools`, run `tool_calls` (in parallel if you
    like — `order` is advisory) and call again with the results appended to
    `history`. On `final`, `answer` is grounded in `used`; anything the tools
    could not supply is named in `unanswered` rather than guessed at. On
    `refused`, show `reason` — do not retry with different wording.
    """
    request_id: str
    status: AssistStatus
    tool_calls: list[ToolCall] = Field(default_factory=list)
    answer: str | None = None
    used: list[str] = Field(default_factory=list)
    unanswered: list[str] = Field(default_factory=list)
    reason: str
    audit: AssistAuditRecord = Field(default_factory=AssistAuditRecord)

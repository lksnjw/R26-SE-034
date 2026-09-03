"""
Gateway contract — the request and response shapes the calling application uses.

This module is a *decision service*, not an executor. The caller sends a natural
language prompt and who is asking; we return whether it is permitted, on what
authority, and what still has to be true. The caller performs the action.

Everything here is part of the published API surface. Changing a field name here
breaks the front-end, so treat it like the action registry: versioned, not
casually edited.
"""
from datetime import datetime, timezone
from enum import Enum
from typing import Any

# pyrefly: ignore [missing-import]
from pydantic import BaseModel, Field

from src.types.policy import Citation, Condition, PolicyDecision


class RequestType(str, Enum):
    ACTION = "action"        # the prompt asks for something to be done
    QUESTION = "question"    # the prompt asks about policy — answered from the corpus
    # Asks for records, totals, or lists. This service holds policy, not data, so
    # it is refused rather than routed onward: a caller reads "routed" as
    # "permitted", and whether records may be disclosed is precisely the kind of
    # decision this service exists to make rather than delegate.
    DATA = "data"
    # A finance request outside the registered vocabulary. Distinct from UNCLEAR:
    # the request was understood, and this system does not do it.
    UNSUPPORTED = "unsupported"
    UNCLEAR = "unclear"      # neither could be established — never executed


class Actor(BaseModel):
    """
    Who is asking.

    Required, and not inferred from the prompt: "approve this as the finance
    manager" is a claim by the requester, not an identity. Roles must come from
    the caller's authenticated session.
    """
    user_id: str = Field(..., min_length=1)
    role: str = Field(..., min_length=1, description="Authenticated role, e.g. finance_officer")
    department: str | None = None
    # Additive for /api/assist's actor-scoped tool-argument overwrite (see
    # docs/ASSIST_CONTRACT.md §3.4) — unused by /api/policy/evaluate today.
    cost_center: str | None = None
    # Set when the actor is also the raiser/beneficiary of the target document.
    # The caller knows this; we cannot look it up. Used for segregation of duties.
    is_document_owner: bool | None = None


class EvaluateRequest(BaseModel):
    prompt: str = Field(..., min_length=1, description="The user's natural language request")
    actor: Actor
    context: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Pre-resolved ERP facts about the target document, e.g. "
            "{'amount': 1450000, 'vendor_id': 'V-221'}. Whatever is supplied is "
            "compared against the limits the policies state; whatever is missing "
            "comes back as an unsatisfied condition."
        ),
    )


class ProposedAction(BaseModel):
    """The action the caller should execute, if the verdict permits it."""
    name: str                            # a name from action_registry, never free text
    parameters: dict[str, Any] = Field(default_factory=dict)
    confidence: str = "high"             # high | low — low means the caller should confirm


class RetrievalStats(BaseModel):
    """
    How the governing rules were found.

    Exposed deliberately: `action_filtered` dropping to zero means the policy
    corpus has no coverage for this action, which is a corpus bug that would
    otherwise be invisible behind a plausible-looking answer.
    """
    mandatory: int = 0
    action_filtered: int = 0
    semantic: int = 0
    total_unique: int = 0


class AuditRecord(BaseModel):
    """What the caller stores to answer 'why was this permitted?' months later."""
    judge_model: str | None = None
    registry_version: str = ""
    policies_seen: list[str] = Field(default_factory=list)   # policy_id@version
    evaluated_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )


class EvaluateResponse(BaseModel):
    """
    The full answer to one prompt.

    Caller contract: execute only on `decision == "allow"`, or on
    `"allow_with_conditions"` once every entry in `conditions` has been satisfied
    against the ERP record. Any other decision is not an instruction to retry.
    """
    request_id: str
    request_type: RequestType
    decision: PolicyDecision
    reason: str
    action: ProposedAction | None = None
    conditions: list[Condition] = Field(default_factory=list)
    citations: list[Citation] = Field(default_factory=list)
    knowledge: str = ""                  # grounded prose for the end user
    retrieval: RetrievalStats = Field(default_factory=RetrievalStats)
    audit: AuditRecord = Field(default_factory=AuditRecord)

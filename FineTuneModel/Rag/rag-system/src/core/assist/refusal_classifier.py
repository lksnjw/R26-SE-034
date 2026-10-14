"""
Refusal classifier — the safety net in front of /api/assist's tool planner.

/api/assist is read-only by construction: a `write`-kind (or unmarked) tool is
dropped and never callable through it, regardless of what any model decides
(see assist_gate._filter_tools). That structural filter is the real boundary.
This classifier is a courtesy layered in front of it — routing between
/api/assist and /api/policy/evaluate is the CALLER's decision
(docs/ASSIST_CONTRACT.md §7), not something inferred here from wording — so
that a caller who funnels everything through one endpoint gets a clear
"use /api/policy/evaluate instead" refusal rather than a confused tool plan.

FAILS CLOSED, unlike intent_extractor._confirm's deliberate fail-open. The two
are not analogous: _confirm fails open because a deterministic rule engine
re-checks everything it protects, downstream. This classifier has no such
backstop — if it failed open, an LLM outage would silently turn the whole
safety net into a pass-through until the backend recovered, and nothing else
would catch that. So any failure here refuses rather than proceeding to plan
tools.
"""
import json
import logging
import re

from src.core.llm.llm_service import get_llm

logger = logging.getLogger(__name__)

_JSON_BLOCK = re.compile(r"\{.*\}", re.DOTALL)

_PROMPT = """\
You classify requests for a read-only ERP assistant. Reply with JSON only, no prose.

This assistant may only look things up — summaries, balances, statuses, reports.
It must never be used to approve, release, post, transfer, reimburse, issue, or
otherwise change anything. Deciding whether a MUTATING request is allowed is a
separate system's job, not this one's.

Classify the request as:
- "action" — asking to DO something that changes ERP state: approve, pay, post,
  release, transfer, reimburse, issue, update, cancel, reject.
- "read"   — asking to look something up, summarize, list, total, or explain.
  Includes questions about policy or how something works.

Examples:
  "give me today's cash position"              -> read
  "what's our outstanding balance with V-221"   -> read
  "summarize this month's travel spend"         -> read
  "what is our payment release limit"           -> read
  "release payment for invoice INV-8842"        -> action
  "approve the Lanka Traders invoice"           -> action
  "post a journal entry for July closing"       -> action
  "cancel purchase order PO-4471"               -> action

A request that would need to change something to answer it (e.g. "approve this
so I can see the updated balance") is "action" — the mutation is the point.

Reply exactly:
{{"request_type": "action|read", "why": "<short>"}}

Request: {prompt}
"""


class ClassifierResult:
    """
    `read` here means "did the classifier itself produce a usable opinion" —
    same naming idea as judge.JudgeResult.read, not related to the "read" tool
    kind. `read=False` means the classifier failed and must be treated as a
    refusal by the caller, never as "assume read-only and proceed."
    """

    def __init__(self, is_action: bool, why: str, read: bool = True) -> None:
        self.is_action = is_action
        self.why = why
        self.read = read


def _parse(raw: str) -> dict:
    match = _JSON_BLOCK.search(raw)
    if not match:
        raise ValueError(f"model returned no JSON object: {raw[:200]}")
    return json.loads(match.group(0))


async def classify(prompt: str) -> ClassifierResult:
    """Never raises. Any failure returns read=False — the caller must refuse."""
    try:
        response = await get_llm().ainvoke(_PROMPT.format(prompt=prompt))
        data = _parse(getattr(response, "content", str(response)))
    except Exception as exc:  # noqa: BLE001 — every failure mode is the same failure
        logger.exception("refusal classifier call failed")
        return ClassifierResult(
            is_action=False,
            why=f"classifier unavailable ({type(exc).__name__})",
            read=False,
        )

    request_type = str(data.get("request_type", "")).lower().strip()
    if request_type not in ("action", "read"):
        logger.error(f"classifier returned unusable request_type: {data!r}")
        return ClassifierResult(is_action=False, why="classifier reply unreadable", read=False)

    why = str(data.get("why") or "").strip()
    return ClassifierResult(is_action=(request_type == "action"), why=why)

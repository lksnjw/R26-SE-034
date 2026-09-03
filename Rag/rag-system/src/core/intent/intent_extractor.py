"""
IntentExtractor — natural language in, one registered action name out.

Two jobs, in order:

  1. CLASSIFY   is this prompt asking a question, or asking for something to be done?
                "what is our payment limit?"  → question, answered from policy text
                "pay invoice 8842"            → action, gated

  2. EXTRACT    map the request to exactly one name from the action registry and
                pull its parameters out of the text.

The model's freedom is bounded on both sides. It may only choose a registered
name — an unregistered name is a refusal, not a new capability — and the
parameters it produces are validated against that action's JSON Schema before
any policy work begins. A malformed request is rejected without ever reaching
the rule store.

Nothing here touches Qdrant. If this stage refuses, no retrieval happens at all.
"""
import json
import logging
import re

from src.core.actions.action_registry import ActionSpec, action_names, all_actions, get_action
from src.core.common.schema_validate import validate_against_schema
from src.core.llm.llm_service import get_llm

logger = logging.getLogger(__name__)

_JSON_BLOCK = re.compile(r"\{.*\}", re.DOTALL)


class IntentError(Exception):
    """Extraction failed. Always fatal to the request — never retried loosely."""


class Intent:
    def __init__(
        self,
        request_type: str,
        action: str | None = None,
        parameters: dict | None = None,
        confidence: str = "high",
        note: str = "",
    ) -> None:
        # "action" | "question" | "data" | "unsupported" | "unclear"
        self.request_type = request_type
        self.action = action
        self.parameters = parameters or {}
        self.confidence = confidence
        self.note = note

    @property
    def spec(self) -> ActionSpec | None:
        return get_action(self.action) if self.action else None


def _catalogue() -> str:
    lines = []
    for spec in all_actions():
        params = ", ".join(spec.params_schema.get("properties", {}))
        lines.append(f"  {spec.name.value}: {spec.description} (params: {params})")
    return "\n".join(lines)


_PROMPT = """\
You classify requests for an ERP finance system. Reply with JSON only, no prose.

MOST REQUESTS ARE NOT SUPPORTED BY THIS SYSTEM. It handles a narrow set of
accounts-payable actions and nothing else. Answering "unsupported" is the correct
and expected reply for anything outside that set — it is not a failure. Do not
choose the closest available action. A request that is *similar to* a listed
action is still unsupported unless it is *the same thing*.

Supported actions:
{catalogue}

Classify as:
- "question"    — asking about a policy, a rule, or how something works.
- "action"      — asking for one of the supported actions above, exactly.
- "data"        — asking for records, lists, totals, or reports
                  ("how much did we spend", "list all employees", "show balances").
- "unsupported" — a finance request this system does not handle, including
                  anything about customers, receivables, receipts, payroll,
                  bank reconciliation, assets, or tax.

Examples:
  "pay invoice 8842"                        -> action, release_payment
  "what is our limit for releasing payment" -> question
  "record a customer payment received"      -> unsupported (money coming IN;
                                               this system only handles payments going OUT)
  "create a customer invoice for 250000"    -> unsupported (sales invoicing, not
                                               supplier invoice approval)
  "write off the receivable from XYZ"       -> unsupported (receivables)
  "reconcile the bank statement for July"   -> unsupported (bank reconciliation)
  "how much did we spend on travel"         -> data
  "who earns more than 25000"               -> data

Extract parameters only where the user actually stated them. Do not guess an
invoice number, an amount, or a vendor that is not present in the request.

Reply exactly:
{{"request_type": "action|question|data|unsupported",
  "action": "<name from the list, or null>",
  "parameters": {{}},
  "reason": "<if unsupported: what capability was asked for>",
  "confidence": "high|low"}}

Request: {prompt}
"""

# Second pass. The first prompt asks "which of these fits?", a question whose
# form has no correct negative answer — offered ten options, a model returns one
# of the ten. This asks "is it the same thing?", which can be answered no.
_CONFIRM = """\
Reply with JSON only.

A user asked: {prompt}

It was interpreted as this system capability:
  {action}: {description}
  This capability {flow}.

Does that capability do what the user asked for?

Answer true when it is the same thing, even if the user worded it differently or
gave fewer details. Different wording is normal and expected.

Answer false only when it is a different thing: the opposite direction of money,
a different party (customer instead of supplier), or a different business process
that merely sounds similar.

Examples:
  "pay invoice 8842" / release_payment (money leaves to a supplier)
      -> true. Same thing, shorter wording.
  "record a customer payment received" / release_payment (money leaves to a supplier)
      -> false. The user described money arriving from a customer.
  "approve the Lanka Traders bill" / approve_invoice (approve a supplier invoice)
      -> true. A bill from a supplier is a supplier invoice.
  "create a customer invoice" / approve_invoice (approve a supplier invoice)
      -> false. Billing a customer is not approving a supplier's bill.

Reply exactly: {{"same": true|false, "why": "<short>"}}
"""

# Plain-language flow, for the confirmation prompt. The raw enum value ("out")
# carries no meaning for a small model and reads as a hint that something is
# wrong — labelling a correct mapping "out" was enough to make it answer false.
_FLOW_PHRASE = {
    "out": "sends money out of this organisation, to a supplier or an employee",
    "in": "receives money into this organisation, from a customer",
    "neutral": "moves no money; it records, reads, or commits",
}


def _parse(raw: str) -> dict:
    match = _JSON_BLOCK.search(raw)
    if not match:
        raise IntentError(f"model returned no JSON object: {raw[:200]}")
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError as exc:
        raise IntentError(f"model returned malformed JSON: {exc}") from exc


# Placeholders models emit for "the user didn't say". They must be stripped, not
# passed on: the caller executes with these parameters, and a vendor_id of the
# string "None" is a value that looks supplied and is not — worse than absent,
# because a missing field is caught by the schema and this one isn't.
_EMPTY_VALUES = {"none", "null", "n/a", "na", "unknown", "unspecified", "", "-"}


def _drop_empty(params: dict) -> dict:
    return {
        k: v
        for k, v in params.items()
        if v is not None and not (isinstance(v, str) and v.strip().lower() in _EMPTY_VALUES)
    }


def validate_parameters(spec: ActionSpec, params: dict) -> list[str]:
    """
    Check extracted parameters against the action's JSON Schema.

    Thin wrapper over the shared validator in `src.core.common.schema_validate`,
    which /api/assist also uses to validate a planner's tool-call arguments
    against a caller-supplied tool spec.
    """
    return validate_against_schema(spec.params_schema, params)


async def _confirm(prompt: str, spec: ActionSpec) -> tuple[bool, str]:
    """
    Second opinion on a proposed mapping. Returns (is_the_same_thing, why_not).

    Fails OPEN deliberately: if this check itself errors, the mapping stands and
    the request proceeds to the policy gate, which is where the real controls are.
    A confirmation pass that can block on its own failure would turn a flaky model
    call into an outage, and it is a safety net rather than a gate — everything it
    protects is checked again downstream, by rules rather than by wording.
    """
    try:
        raw = await get_llm().ainvoke(
            _CONFIRM.format(
                prompt=prompt,
                action=spec.name.value,
                description=spec.description,
                flow=_FLOW_PHRASE[spec.flow.value],
            )
        )
        data = _parse(getattr(raw, "content", str(raw)))
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"confirmation pass unavailable ({type(exc).__name__}); mapping stands")
        return True, ""

    same = data.get("same")
    if isinstance(same, str):
        same = same.strip().lower() not in ("false", "no", "0")
    return bool(same), str(data.get("why") or "").strip()


async def extract(prompt: str) -> Intent:
    """
    Classify and extract. Raises IntentError when the model output is unusable.

    A prompt naming no registered action returns request_type="unclear" rather
    than a best guess: executing the nearest-sounding action is how an assistant
    pays the wrong invoice.
    """
    llm = get_llm()
    message = _PROMPT.format(catalogue=_catalogue(), prompt=prompt)
    response = await llm.ainvoke(message)
    data = _parse(getattr(response, "content", str(response)))

    request_type = str(data.get("request_type", "unclear")).lower().strip()
    if request_type not in ("action", "question", "data", "unsupported", "unclear"):
        request_type = "unclear"

    action = data.get("action")
    action = str(action).strip() if action else None
    reason = str(data.get("reason") or "").strip()

    if request_type in ("data", "unsupported"):
        return Intent(request_type=request_type, note=reason)

    if request_type == "action":
        if not action or action not in action_names():
            logger.warning(
                f"model proposed unregistered action {action!r} — treating as unsupported"
            )
            return Intent(
                request_type="unsupported",
                note=reason or f"'{action}' is not a capability of this system",
            )

        spec = get_action(action)
        confirmed, why = await _confirm(prompt, spec)
        if not confirmed:
            # The mapping was plausible and wrong. This is the case that let a
            # customer receipt through as an outbound payment.
            logger.warning(
                f"confirmation rejected mapping {prompt[:60]!r} -> {action}: {why}"
            )
            return Intent(
                request_type="unsupported",
                note=why or f"this system does not handle that; the nearest "
                            f"capability ({action}) is not the same thing",
            )

    params = data.get("parameters") or {}
    if not isinstance(params, dict):
        params = {}
    params = _drop_empty(params)

    confidence = "low" if str(data.get("confidence", "")).lower() == "low" else "high"

    logger.info(
        f"intent: type={request_type} action={action} "
        f"params={list(params)} confidence={confidence}"
    )
    return Intent(request_type, action, params, confidence)

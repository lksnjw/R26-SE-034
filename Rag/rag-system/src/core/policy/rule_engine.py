"""
RuleEngine — the deterministic half of the decision.

A language model comparing 1,450,000 against a 1,000,000 limit is unreliable in a
way that an arithmetic comparison is not. So every check that *can* be arithmetic
is done here, in Python, before the judge is asked anything.

THRESHOLDS ARE AUTHORED, NEVER INFERRED
Each rule states its own limit in front-matter (`threshold_value` + `threshold_unit`)
alongside the same limit in its clause text. This engine reads that field. It does
not parse numbers out of prose, and it does not invent a limit for a rule that
states none — such a rule is simply passed to the judge as text.

WHAT IT CANNOT KNOW
This module holds policies, not ERP data. Whether *this* payment is above the
stated limit depends on facts only the caller has. When the fact is supplied in
`context` we compare it and mark the condition satisfied; when it is missing we
return the condition unsatisfied with the limit attached, for the caller to check.
Missing is never treated as passing.
"""
import logging

from src.core.actions.action_registry import ActionSpec
from src.core.policy.policy_retriever import PolicyChunk
from src.types.gateway import Actor
from src.types.policy import Condition, ConditionType, ThresholdUnit

logger = logging.getLogger(__name__)

# Which `context` fact a rule's threshold is compared against, decided by the unit
# the rule itself declares. A convention, published in the payload contract —
# not an inference about what the rule "probably" means.
_UNIT_FIELD: dict[ThresholdUnit, str] = {
    ThresholdUnit.ABSOLUTE: "amount",
    ThresholdUnit.PERCENT: "percentage",
    ThresholdUnit.DAYS: "days",
}

# The check a policy claims to back via its `enforces` tag.
SEGREGATION_OF_DUTIES = "segregation_of_duties"


def _num(value: float) -> str:
    """
    Money and day counts as a person writes them.

    `%g` renders 1000000 as '1e+06'. This text is read by whoever was refused,
    and a limit shown in scientific notation is a limit they have to decode.
    """
    if float(value).is_integer():
        return f"{int(value):,}"
    return f"{value:,.2f}"


def _authority_for(check: str, chunks: list[PolicyChunk]) -> str | None:
    """
    The clause that states a code-enforced rule, or None if none was retrieved.

    Guessing here — "use the first mandatory policy" — produced a denial citing
    the data-privacy policy for a segregation breach: a reference that sends the
    requester to a rule which says nothing of the kind.
    """
    for chunk in chunks:
        if check in chunk.meta.enforces:
            return chunk.meta.citation
    return None


class RuleOutcome:
    """
    Result of the deterministic pass.

    `hard_denials` are breaches established as fact — no judgement involved and
    no condition the caller could satisfy. They end the decision immediately.
    """

    def __init__(self) -> None:
        self.conditions: list[Condition] = []
        self.hard_denials: list[tuple[str, str]] = []   # (reason, source ref)

    @property
    def unmet(self) -> list[Condition]:
        return [c for c in self.conditions if c.blocks_execution]


def _threshold_condition(chunk: PolicyChunk, context: dict) -> Condition | None:
    """Turn a rule's authored limit into a condition, checked if we have the fact."""
    meta = chunk.meta
    if meta.threshold_value is None or meta.threshold_unit is None:
        return None

    field = _UNIT_FIELD[meta.threshold_unit]
    supplied = context.get(field)

    satisfied: bool | None = None
    if isinstance(supplied, (int, float)) and not isinstance(supplied, bool):
        satisfied = float(supplied) <= float(meta.threshold_value)

    unit_label = {
        ThresholdUnit.ABSOLUTE: "",
        ThresholdUnit.PERCENT: "%",
        ThresholdUnit.DAYS: " days",
    }[meta.threshold_unit]

    return Condition(
        type=ConditionType.THRESHOLD,
        description=(
            f"{meta.title or meta.policy_id} sets a limit of "
            f"{_num(meta.threshold_value)}{unit_label} for this action"
            + ("" if satisfied is None else
               f"; the supplied {field} of {_num(supplied)} is "
               f"{'within' if satisfied else 'above'} it")
        ),
        source=meta.citation,
        field=field,
        operator="<=",
        value=meta.threshold_value,
        unit=meta.threshold_unit.value,
        # Exceeding a stated limit does not forbid the action — it escalates who
        # must authorise it. That escalation is what the caller has to satisfy.
        else_require=list(meta.requires_role) or ["higher_authorization"],
        satisfied=satisfied,
    )


def _role_condition(chunk: PolicyChunk, actor: Actor) -> Condition | None:
    """The actor's authenticated role against the roles the rule names."""
    meta = chunk.meta
    if not meta.requires_role:
        return None

    holds = actor.role in meta.requires_role
    return Condition(
        type=ConditionType.ROLE,
        description=(
            f"{meta.title or meta.policy_id} requires one of: "
            f"{', '.join(meta.requires_role)}; actor holds '{actor.role}'"
        ),
        source=meta.citation,
        field="actor.role",
        operator="in",
        value=list(meta.requires_role),
        satisfied=holds,
    )


def evaluate(
    spec: ActionSpec,
    chunks: list[PolicyChunk],
    actor: Actor,
    context: dict,
) -> RuleOutcome:
    """Run every deterministic check the retrieved rules support."""
    outcome = RuleOutcome()
    seen_sources: set[str] = set()

    # Segregation of duties. The caller tells us whether the actor raised or
    # benefits from the document; we cannot look it up. True is a fact, so it
    # denies outright. None is unknown, so it becomes a condition — never a pass.
    if spec.self_approval_forbidden:
        governing = _authority_for(SEGREGATION_OF_DUTIES, chunks)
        if governing is None:
            # No retrieved clause claims to impose this check. Denying here would
            # cite nothing; passing silently would drop a control. Report it as a
            # corpus defect and make the caller confirm it by hand.
            logger.error(
                f"no retrieved policy is tagged enforces=['{SEGREGATION_OF_DUTIES}'] — "
                f"the segregation check cannot be attributed to a clause"
            )
            outcome.conditions.append(
                Condition(
                    type=ConditionType.SEGREGATION,
                    description=(
                        "Segregation of duties must be confirmed manually: no policy "
                        "in the corpus is tagged as the authority for this check"
                    ),
                    source="unattributed",
                    field="actor.is_document_owner",
                    operator="==",
                    value=False,
                    satisfied=None,
                )
            )
        elif actor.is_document_owner is True:
            outcome.hard_denials.append(
                (
                    f"Segregation of duties: {actor.user_id} raised or benefits from "
                    f"this document and may not also {spec.name.value.replace('_', ' ')}.",
                    governing,
                )
            )
        elif actor.is_document_owner is None:
            outcome.conditions.append(
                Condition(
                    type=ConditionType.SEGREGATION,
                    description=(
                        f"Confirm {actor.user_id} did not raise, request, or benefit "
                        f"from this document before executing"
                    ),
                    source=governing,
                    field="actor.is_document_owner",
                    operator="==",
                    value=False,
                    satisfied=None,
                )
            )

    for chunk in chunks:
        # Only rules that actually govern this action may impose conditions.
        # A chunk pulled in by similarity belongs to some other action's policy —
        # letting it contribute would attach the travel-claim 14-day window to a
        # payment release just because the wording looked close.
        if chunk.via == "semantic":
            continue

        # One condition per rule, not per chunk. The key is the policy and version,
        # NOT the citation — a citation carries the section, so keying on it lets a
        # policy split across clauses restate its own single limit once per clause.
        rule_key = f"{chunk.meta.policy_id}@{chunk.meta.version}"
        if rule_key in seen_sources:
            continue

        threshold = _threshold_condition(chunk, context)
        role = _role_condition(chunk, actor)
        if threshold or role:
            seen_sources.add(rule_key)
        if threshold:
            outcome.conditions.append(threshold)
        if role:
            outcome.conditions.append(role)

    logger.info(
        f"rule engine | {len(outcome.conditions)} condition(s), "
        f"{len(outcome.unmet)} unmet, {len(outcome.hard_denials)} hard denial(s)"
    )
    return outcome

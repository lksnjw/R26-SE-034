"""
PolicyGate — the orchestrator behind POST /api/policy/evaluate.

    prompt + actor
        ↓  classify + extract     (LLM, bounded by the action registry)
        ↓  validate parameters    (JSON Schema, deterministic)
        ↓  retrieve               (three-query union over Qdrant)
        ↓  rule engine            (thresholds / roles / segregation, deterministic)
        ↓  judge                  (narrative clauses only, must cite)
    verdict + action + conditions + citations

The caller executes; this module never does. Its whole output is a
recommendation with the authority attached.

FAILURE POSTURE
Every stage that cannot complete produces a denial, not an exception and not a
default-allow. Concretely: an unreachable Qdrant denies, an unreachable judge
denies, an unparseable model reply denies, an action with no policy coverage
denies. The one thing this module must never do is return an executable verdict
derived from rules it did not actually read.
"""
import logging
import uuid

from src.core.actions.action_registry import REGISTRY_VERSION, get_action
from src.core.intent import intent_extractor
from src.core.policy import judge as judge_module
from src.core.policy import rule_engine
from src.core.policy.policy_retriever import RetrievalResult, get_policy_retriever
from src.types.gateway import (
    AuditRecord,
    EvaluateRequest,
    EvaluateResponse,
    ProposedAction,
    RequestType,
    RetrievalStats,
)
from src.types.policy import Condition, PolicyDecision

logger = logging.getLogger(__name__)


def _stats(result: RetrievalResult | None) -> RetrievalStats:
    if result is None:
        return RetrievalStats()
    return RetrievalStats(
        mandatory=result.counts["mandatory"],
        action_filtered=result.counts["action"],
        semantic=result.counts["semantic"],
        total_unique=result.total_unique,
    )


def _refuse(
    request_id: str,
    reason: str,
    request_type: RequestType = RequestType.UNCLEAR,
    **kw,
) -> EvaluateResponse:
    # A caller that has already built an audit record (one that knows which
    # policies were seen) keeps it; only a refusal with no history gets the bare one.
    kw.setdefault("audit", AuditRecord(registry_version=REGISTRY_VERSION))
    return EvaluateResponse(
        request_id=request_id,
        request_type=request_type,
        decision=PolicyDecision.DENY,
        reason=reason,
        **kw,
    )


async def evaluate(request: EvaluateRequest) -> EvaluateResponse:
    """
    Decide one request. Never raises — a failure is a denial with a reason.

    The guard is here, around everything, rather than only on the steps we
    currently expect to fail. Each stage below handles its own known failures
    and phrases them usefully; this catches the rest. An unforeseen exception
    escaping to the caller would surface as a transport error, and a caller
    holding a pending payment and an HTTP 500 is exactly the state the gate
    exists to prevent — the answer to "we don't know" must be a denial, not
    an absence of one.
    """
    try:
        return await _evaluate(request)
    except Exception as exc:  # noqa: BLE001 — every unhandled failure is one failure
        logger.exception("policy gate failed")
        return _refuse(
            str(uuid.uuid4()),
            f"The policy gate could not complete this decision "
            f"({type(exc).__name__}); the action is not authorized.",
        )


async def _evaluate(request: EvaluateRequest) -> EvaluateResponse:
    request_id = str(uuid.uuid4())
    prompt = request.prompt.strip()
    actor = request.actor

    logger.info(f"[{request_id}] evaluate | actor={actor.user_id}/{actor.role} | {prompt[:80]!r}")

    # ── 1. Classify and extract ───────────────────────────────────────────────
    try:
        intent = await intent_extractor.extract(prompt)
    except intent_extractor.IntentError as exc:
        return _refuse(request_id, f"Could not interpret the request: {exc}")
    except Exception as exc:  # noqa: BLE001 — model/transport failures look alike
        logger.exception("intent extraction failed")
        return _refuse(
            request_id,
            f"Language model unavailable ({type(exc).__name__}); the request "
            f"cannot be interpreted.",
        )

    if intent.request_type == "question":
        return await _answer_question(request_id, prompt, request)

    if intent.request_type == "data":
        # Not answered from the policy corpus. Asked "who earns more than 25000",
        # the semantic search returned the payment-release policy — because that
        # phrasing embeds near payment thresholds — and would have answered a
        # payroll question out of a payments rule. Refusing names the boundary.
        return _refuse(
            request_id,
            "This service decides whether finance actions are permitted; it does "
            "not hold ledger, employee, or transaction records and cannot answer "
            "questions about them. Ask the reporting system for data."
            + (f" ({intent.note})" if intent.note else ""),
            request_type=RequestType.DATA,
        )

    if intent.request_type == "unsupported":
        return _refuse(
            request_id,
            intent.note
            or "This system governs a specific set of accounts-payable actions, "
               "and the request is not one of them.",
            request_type=RequestType.UNSUPPORTED,
        )

    if intent.request_type != "action" or not intent.action:
        return _refuse(
            request_id,
            intent.note
            or "The request does not correspond to any action this system can perform.",
        )

    spec = get_action(intent.action)
    if spec is None:
        # Belt and braces: extractor already rejects unregistered names.
        return _refuse(request_id, f"'{intent.action}' is not a registered action.")

    # ── 2. Validate parameters ────────────────────────────────────────────────
    problems = intent_extractor.validate_parameters(spec, intent.parameters)
    if problems:
        return _refuse(
            request_id,
            "The request is missing information needed to act on it: "
            + "; ".join(problems),
            request_type=RequestType.ACTION,
            action=ProposedAction(
                name=spec.name.value,
                parameters=intent.parameters,
                confidence=intent.confidence,
            ),
        )

    proposed = ProposedAction(
        name=spec.name.value,
        parameters=intent.parameters,
        confidence=intent.confidence,
    )

    # ── 3. Retrieve governing rules ───────────────────────────────────────────
    try:
        retrieved = get_policy_retriever().retrieve(spec.name.value, prompt)
    except Exception as exc:  # noqa: BLE001
        logger.exception("policy retrieval failed")
        return _refuse(
            request_id,
            f"Policy store unavailable ({type(exc).__name__}); no action can be "
            f"authorized without reading the rules that govern it.",
            request_type=RequestType.ACTION,
            action=proposed,
        )

    if retrieved.counts["action"] == 0:
        return _refuse(
            request_id,
            f"No current policy governs '{spec.name.value}'. An action with no "
            f"governing rule cannot be authorized.",
            request_type=RequestType.ACTION,
            action=proposed,
            retrieval=_stats(retrieved),
            audit=AuditRecord(
                registry_version=REGISTRY_VERSION, policies_seen=retrieved.policy_refs
            ),
        )

    # ── 4. Deterministic checks ───────────────────────────────────────────────
    outcome = rule_engine.evaluate(spec, retrieved.chunks, actor, request.context)

    if outcome.hard_denials:
        reason, source = outcome.hard_denials[0]
        return EvaluateResponse(
            request_id=request_id,
            request_type=RequestType.ACTION,
            decision=PolicyDecision.DENY,
            reason=reason,
            action=proposed,
            conditions=outcome.conditions,
            citations=_citations_for(source, retrieved),
            retrieval=_stats(retrieved),
            audit=AuditRecord(
                registry_version=REGISTRY_VERSION, policies_seen=retrieved.policy_refs
            ),
        )

    # ── 5. Judge the rest ─────────────────────────────────────────────────────
    verdict = await judge_module.judge(
        action=spec.name.value,
        parameters=intent.parameters,
        prompt=prompt,
        actor=actor,
        chunks=retrieved.chunks,
        established_facts=_facts(outcome.conditions),
    )

    # ── 6. Combine ────────────────────────────────────────────────────────────
    # The deterministic result decides; the judge annotates. It may escalate to
    # review, never to deny.
    #
    # This was the other way round, and it did not survive contact with a small
    # model. Measured on five requests that every check passed — in-limit
    # amounts, correct roles, segregation resolved — four were denied by a judge
    # returning a bare {"decision": "deny"} with no reason and no citation. The
    # gate honoured it, because a deny with no citation is not rejected the way
    # an uncited allow is. So the path of least effort for a struggling model was
    # the one the gate trusted most, and the deterministic layer's correct answer
    # was discarded on the strength of an empty JSON object.
    #
    # Escalation still works: a judge that reads a narrative clause and says so
    # sends the request to a human. What it can no longer do is refuse a request
    # that every stated rule permits, without saying which rule refused it.
    decision, reason = _combine(verdict, outcome)

    citations = verdict.citations
    if not citations:
        # Every verdict has to name the rules it rests on. A refusal that cites
        # nothing leaves the requester told "no" with nothing to look up; an
        # authorization that cites nothing cannot be audited later. The judge
        # often names a policy in prose without emitting it as a structured
        # reference, so fall back to the conditions the rule engine actually
        # evaluated — unmet ones are the grounds for a refusal, satisfied ones
        # are the authority for an allow.
        # Failed checks first: when one exists it is the grounds for the refusal,
        # and citing an unresolved condition instead would name a rule that did
        # not refuse anything.
        relevant = (
            [c for c in outcome.conditions if c.satisfied is False]
            or outcome.unmet
            or [c for c in outcome.conditions if c.satisfied is True]
        )
        citations = _citations_for_conditions(relevant, retrieved)

    return EvaluateResponse(
        request_id=request_id,
        request_type=RequestType.ACTION,
        decision=decision,
        reason=reason,
        action=proposed,
        conditions=outcome.conditions,
        citations=citations,
        knowledge=_knowledge(retrieved),
        retrieval=_stats(retrieved),
        audit=AuditRecord(
            judge_model=verdict.model,
            registry_version=REGISTRY_VERSION,
            policies_seen=retrieved.policy_refs,
        ),
    )


def _combine(verdict, outcome) -> tuple[PolicyDecision, str]:
    """
    Deterministic outcome + judge annotation -> the decision returned.

    Hard denials never reach here; they returned earlier with their own citation.
    So what is left is a request no stated rule refused, and the question is only
    whether every condition could actually be checked.

        all conditions satisfied   -> allow
        any condition unresolved   -> allow_with_conditions
        judge says review          -> review, whatever the conditions say

    A judge `deny` is downgraded to `review` rather than dropped: it read
    something in the narrative clauses worth a second look, and a human should
    see it — but "a model said no" is not itself a policy, and the requester is
    owed the rule that refused them. Where the judge supplies a reason, it is
    carried through; an empty verdict falls back to describing the conditions.
    """
    # `unmet` merges two different answers: a check that ran and FAILED
    # (satisfied False) and a check that could not run at all (satisfied None).
    # They must not produce the same verdict — the first is a breach, the second
    # is a question for the caller. Separating them is only load-bearing now that
    # the judge is advisory: while it could deny, an over-limit amount was caught
    # downstream by the model, so treating both as "conditional" was survivable.
    # It is not survivable any more, and 1,450,000 against a 1,000,000 limit
    # came back allow_with_conditions until this split existed.
    failed = [c for c in outcome.conditions if c.satisfied is False]
    unresolved = [c for c in outcome.conditions if c.satisfied is None]
    judge_reason = (verdict.reason or "").strip()
    uninformative = not judge_reason or judge_reason.startswith("No reason supplied")

    if not verdict.read:
        # The narrative clauses were never evaluated — judge unreachable,
        # unparseable, or citing authority it was not shown. Invariant 1 holds
        # unchanged: nothing is authorized on rules nobody read.
        return PolicyDecision.DENY, judge_reason

    # An opinion escalates. An empty one is discarded.
    #
    # A judge that names a clause and says why has read something the rule engine
    # could not check, and a human should see it. A bare {"decision": "deny"} —
    # no reason, no citation — is not a finding about the policy; it is the
    # cheapest token sequence the model could emit. Escalating on it sends every
    # valid request to a human queue, which fails just as usefully as denying
    # them did. So it changes nothing, and the deterministic result stands.
    if failed:
        # A stated rule was checked against a supplied fact and did not hold.
        # That is a refusal on the policy's own terms, and it names the rule.
        first = failed[0]
        others = (
            f" ({len(failed) - 1} further check(s) also failed.)"
            if len(failed) > 1 else ""
        )
        return PolicyDecision.DENY, f"{first.description}.{others}"

    objected = verdict.decision in (PolicyDecision.REVIEW, PolicyDecision.DENY)
    if objected and not (uninformative and not verdict.citations):
        return PolicyDecision.REVIEW, judge_reason

    if unresolved:
        base = judge_reason if not uninformative else (
            "Every rule that could be checked against the facts supplied is satisfied."
        )
        return (
            PolicyDecision.ALLOW_WITH_CONDITIONS,
            f"{base} {len(unresolved)} condition(s) must be satisfied before executing.",
        )

    reason = judge_reason if not uninformative else (
        "Permitted: every applicable rule was checked against the facts supplied "
        "and each one is satisfied."
    )
    return PolicyDecision.ALLOW, reason


def _facts(conditions: list[Condition]) -> list[str]:
    """
    Settled numeric results, phrased for the judge.

    Only conditions we actually checked are passed on. An unchecked condition is
    withheld deliberately — telling the judge "the limit is 1,000,000" without
    telling it the amount invites it to do the arithmetic we removed from it.
    """
    facts = []
    for condition in conditions:
        if condition.satisfied is None:
            continue
        state = "SATISFIED" if condition.satisfied else "NOT SATISFIED"
        facts.append(f"{condition.description} [{state}, per {condition.source}]")
    return facts


def _citations_for(source: str, retrieved: RetrievalResult):
    """
    Build a citation for a deterministic denial from the chunk it came from.

    Two passes, and the order is the point. A single pass accepting either an
    exact clause match or a policy_id match returns whichever chunk of that
    policy came first in retrieval order — so a segregation denial sourced to
    FIN-GOV-2026-001@1.0#2 was cited as #3, "Evidence and authority", quoting
    text about emailed instructions. The document-level fallback is for when the
    exact clause was not retrieved; it must never pre-empt a clause that was.
    """
    from src.types.policy import Citation

    def _cite(chunk):
        return [
            Citation(
                policy_id=chunk.meta.policy_id,
                version=chunk.meta.version,
                section=chunk.meta.section,
                title=chunk.meta.title,
                quote=chunk.text[:300],
            )
        ]

    for chunk in retrieved.chunks:
        if chunk.meta.citation == source:
            return _cite(chunk)

    for chunk in retrieved.chunks:
        if chunk.meta.policy_id == source.split("@")[0]:
            return _cite(chunk)

    return []


def _citations_for_conditions(conditions: list[Condition], retrieved: RetrievalResult):
    """Citations for the rules behind a set of conditions, in condition order."""
    citations = []
    seen: set[str] = set()
    for condition in conditions:
        if condition.source in seen or condition.source == "unattributed":
            continue
        seen.add(condition.source)
        citations.extend(_citations_for(condition.source, retrieved))
    return citations


def _knowledge(retrieved: RetrievalResult) -> str:
    """
    The rules relied upon, named for the end user.

    Headings only, and only for chunks retrieved by filter. This is a reference
    list, not an explanation — the explanation is `reason`, and the clause text
    itself may be subject to the disclosure limits in the privacy policy.
    """
    lines = []
    seen: set[str] = set()
    for chunk in retrieved.chunks:
        if chunk.via == "semantic" or chunk.meta.policy_id in seen:
            continue
        seen.add(chunk.meta.policy_id)
        lines.append(f"{chunk.meta.policy_id}@{chunk.meta.version} — {chunk.meta.title}")
    return "\n".join(lines[:8])


# ── Question path ────────────────────────────────────────────────────────────


async def _answer_question(
    request_id: str, prompt: str, request: EvaluateRequest
) -> EvaluateResponse:
    """
    Answer a policy question from the policy collection.

    Retrieval here is semantic — there is no action to filter on — but it stays
    inside `policy_docs` with the same doc_type and is_current filters, so a
    question can never be answered out of company data or a superseded rule.
    """
    try:
        chunks = get_policy_retriever().search_semantic(prompt)
    except Exception as exc:  # noqa: BLE001
        logger.exception("question retrieval failed")
        return _refuse(
            request_id,
            f"Policy store unavailable ({type(exc).__name__}).",
            request_type=RequestType.QUESTION,
        )

    if not chunks:
        return EvaluateResponse(
            request_id=request_id,
            request_type=RequestType.QUESTION,
            decision=PolicyDecision.ANSWER,
            reason="No policy in the knowledge base addresses this question.",
            audit=AuditRecord(registry_version=REGISTRY_VERSION),
        )

    from src.types.policy import Citation

    return EvaluateResponse(
        request_id=request_id,
        request_type=RequestType.QUESTION,
        decision=PolicyDecision.ANSWER,
        reason="Informational answer — no action was requested, so nothing is authorized.",
        knowledge="\n\n".join(f"{c.meta.citation}: {c.text}" for c in chunks[:4]),
        citations=[
            Citation(
                policy_id=c.meta.policy_id,
                version=c.meta.version,
                section=c.meta.section,
                title=c.meta.title,
                quote=c.text[:300],
            )
            for c in chunks[:4]
        ],
        retrieval=RetrievalStats(semantic=len(chunks), total_unique=len(chunks)),
        audit=AuditRecord(registry_version=REGISTRY_VERSION),
    )

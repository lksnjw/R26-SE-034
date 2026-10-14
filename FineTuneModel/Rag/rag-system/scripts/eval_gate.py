"""
Golden cases for the policy gate.

These are the properties the design claims. Each one corresponds to a way the
gate could be wrong in a manner that looks perfectly fine in a demo:

  1. a rule missed because the request was phrased casually
  2. a decision made on a policy that was replaced last year
  3. an ERP record read as if it were a rule
  4. an approval by the person who raised the document
  5. a threshold treated as satisfied because nobody checked it
  6. an allow produced while the judge was unreachable
  7. a citation to a policy that was never retrieved

Run from the rag-system directory (Qdrant and Ollama must be up, corpus seeded):
    .venv/Scripts/python.exe -m scripts.eval_gate
    .venv/Scripts/python.exe -m scripts.eval_gate --retrieval-only   # no LLM needed
"""
import argparse
import asyncio
import logging
import sys

from src.core.actions.action_registry import MoneyFlow, get_action
from src.core.policy.policy_gate import evaluate
from src.core.policy.policy_retriever import get_policy_retriever
from src.types.gateway import Actor, EvaluateRequest, RequestType
from src.types.policy import PolicyDecision

logging.basicConfig(level=logging.WARNING, format="%(levelname)-7s %(name)s | %(message)s")

PASS, FAIL = "PASS", "FAIL"
_results: list[tuple[str, str, str]] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    _results.append((PASS if condition else FAIL, name, detail))
    marker = "  ok  " if condition else " FAIL "
    print(f"[{marker}] {name}")
    if detail and not condition:
        print(f"          {detail}")


# ── Retrieval-level cases (no LLM) ───────────────────────────────────────────


def retrieval_cases() -> None:
    retriever = get_policy_retriever()

    # 1. Casual phrasing must not lose the governing rule.
    vague = retriever.retrieve("release_payment", "just push this one through, it's urgent")
    refs = {c.meta.policy_id for c in vague.chunks}
    check(
        "1. casual phrasing still retrieves the payment authorization rule",
        "FIN-PAY-2026-003" in refs,
        f"retrieved: {sorted(refs)}",
    )
    check(
        "1b. the rule was found by filter, not by similarity ranking",
        any(
            c.meta.policy_id == "FIN-PAY-2026-003" and c.via in ("action", "mandatory")
            for c in vague.chunks
        ),
    )

    # 2. Superseded policies must be unreachable for a decision.
    everything = set()
    for action in ("approve_invoice", "release_payment", "update_vendor_bank_details"):
        result = retriever.retrieve(action, "approve this invoice for payment")
        everything |= {c.meta.policy_id for c in result.chunks}
    check(
        "2. superseded FIN-AP-2023-011 never appears",
        "FIN-AP-2023-011" not in everything,
        f"leaked into: {sorted(everything)}",
    )

    # 3. Company data must never surface as authority.
    data_ids = {"DATA-V-221", "DATA-CC-FIN-2026"}
    check(
        "3. company_data never appears in policy retrieval",
        not (everything & data_ids),
        f"leaked: {sorted(everything & data_ids)}",
    )

    # Mandatory rules are retrieved for every action, unconditionally.
    check(
        "3b. the mandatory governance policy is retrieved for every action",
        "FIN-GOV-2026-001" in everything,
    )

    # Every registered action has policy coverage.
    from src.core.actions.action_registry import action_names

    uncovered = [a for a in action_names() if not retriever.has_coverage(a)]
    check(
        "3c. every registered action has at least one governing policy",
        not uncovered,
        f"uncovered: {uncovered}",
    )


# ── Full-gate cases (needs the LLM) ──────────────────────────────────────────


async def gate_cases() -> None:
    officer = Actor(user_id="U-1180", role="finance_editor", department="FIN")
    manager = Actor(user_id="U-2001", role="finance_manager", department="FIN")

    # 4. The person who raised the document may not approve it.
    self_approval = await evaluate(
        EvaluateRequest(
            prompt="approve invoice INV-8842",
            actor=Actor(
                user_id="U-1180", role="finance_manager", is_document_owner=True
            ),
            context={"amount": 400000},
        )
    )
    check(
        "4. segregation of duties denies self-approval",
        self_approval.decision == PolicyDecision.DENY,
        f"got {self_approval.decision.value}: {self_approval.reason}",
    )
    check(
        "4b. the denial cites the governance policy",
        any(c.policy_id == "FIN-GOV-2026-001" for c in self_approval.citations),
        f"cited: {[c.ref for c in self_approval.citations]}",
    )
    # Citing the right document is not enough. This assertion only checked
    # policy_id, and passed while the denial cited FIN-GOV-2026-001#3 "Evidence
    # and authority" — a clause about emailed instructions, quoted at someone
    # refused for self-approval. The clause has to be the one that states the
    # rule, and the quote has to be the text they were refused under.
    gov = [c for c in self_approval.citations if c.policy_id == "FIN-GOV-2026-001"]
    check(
        "4c. the citation names the segregation clause, not merely the policy",
        any(c.section == "2" for c in gov),
        f"sections cited: {[c.section for c in gov]}",
    )
    check(
        "4d. the quoted text is the segregation rule itself",
        any("segregation" in c.title.lower() or "may approve" in c.quote.lower()
            for c in gov),
        f"quotes: {[c.quote[:60] for c in gov]}",
    )

    # 5. An unverifiable threshold must never become a bare allow.
    no_amount = await evaluate(
        EvaluateRequest(
            prompt="release payment for invoice INV-8842",
            actor=manager,
            context={},                      # amount deliberately withheld
        )
    )
    check(
        "5. missing amount yields conditions, never a bare allow",
        no_amount.decision != PolicyDecision.ALLOW,
        f"got {no_amount.decision.value}",
    )
    check(
        "5b. the unchecked threshold is returned with its stated limit",
        any(
            c.type.value == "threshold" and c.satisfied is None and c.value == 1000000
            for c in no_amount.conditions
        ),
        f"conditions: {[(c.type.value, c.value, c.satisfied) for c in no_amount.conditions]}",
    )

    # A supplied amount over the limit is checked here, not by the model.
    over_limit = await evaluate(
        EvaluateRequest(
            prompt="release payment for invoice INV-8842",
            actor=manager,
            context={"amount": 1450000},
        )
    )
    check(
        "5c. an amount above the stated limit is marked unsatisfied deterministically",
        any(
            c.type.value == "threshold" and c.satisfied is False
            for c in over_limit.conditions
        ),
        f"conditions: {[(c.field, c.value, c.satisfied) for c in over_limit.conditions]}",
    )
    # 5d/5e assert the DECISION, not just the condition flag. 5c passed
    # throughout a regression that returned allow_with_conditions for 1,450,000
    # against a 1,000,000 limit: the condition was correctly marked False and the
    # verdict ignored it, because "failed" and "could not be checked" were being
    # collapsed into one bucket. A breach and an open question are not the same
    # answer, and only the verdict shows which one the caller is given.
    check(
        "5d. a failed threshold check denies, it is not merely a condition",
        over_limit.decision == PolicyDecision.DENY,
        f"got {over_limit.decision.value}: {over_limit.reason[:80]}",
    )

    wrong_role = await evaluate(
        EvaluateRequest(
            prompt="release payment for invoice INV-8842",
            actor=Actor(user_id="U-9", role="inventory_manager", department="OPS",
                        is_document_owner=False),
            context={"amount": 150000},
        )
    )
    check(
        "5e. an actor without an authorized role is denied",
        wrong_role.decision == PolicyDecision.DENY,
        f"got {wrong_role.decision.value}: {wrong_role.reason[:80]}",
    )

    # The happy path has to actually be reachable. A gate that never returns a
    # plain allow is indistinguishable from one that is broken, and every
    # assertion above would still pass.
    permitted = await evaluate(
        EvaluateRequest(
            prompt="release payment for invoice INV-8842",
            actor=Actor(user_id="U-2001", role="finance_manager", department="FIN",
                        is_document_owner=False),
            context={"amount": 150000},
        )
    )
    check(
        "5f. a fully compliant request is allowed outright",
        permitted.decision == PolicyDecision.ALLOW,
        f"got {permitted.decision.value}: {permitted.reason[:80]}",
    )
    check(
        "5g. the allow names the rules it rests on",
        len(permitted.citations) > 0,
        f"citations: {[c.ref for c in permitted.citations]}",
    )

    # 7. Every citation must resolve to a policy that was actually retrieved.
    for response in (self_approval, no_amount, over_limit):
        seen = set(response.audit.policies_seen)
        cited = {f"{c.policy_id}@{c.version}" for c in response.citations}
        check(
            f"7. citations resolve to retrieved policies [{response.request_id[:8]}]",
            cited <= seen,
            f"cited but not retrieved: {sorted(cited - seen)}",
        )

    # An unregistered request must be refused, not mapped to the nearest action.
    off_scope = await evaluate(
        EvaluateRequest(
            prompt="terminate employee 4471 and pay their final settlement",
            actor=manager,
        )
    )
    check(
        "8. an action outside the finance vocabulary is refused",
        off_scope.decision == PolicyDecision.DENY,
        f"got {off_scope.decision.value}: {off_scope.reason}",
    )

    # A question must not be dressed up as an authorization.
    question = await evaluate(
        EvaluateRequest(prompt="what is our limit for releasing a payment?", actor=officer)
    )
    check(
        "9. a question returns knowledge, authorizes nothing",
        question.decision == PolicyDecision.ANSWER and question.action is None,
        f"got {question.decision.value}",
    )

    # 10. Adjacent vocabulary — the case case 8 missed. An obviously foreign
    # action (an HR one) is easy to refuse; a neighbouring finance request is
    # what actually gets coerced into the nearest registered action.
    adjacent = {
        "record a customer payment received for invoice INV-99": "customer receipt",
        "create a new customer invoice for 250000 to ABC Traders": "sales invoice",
        "write off the outstanding receivable from XYZ Ltd": "receivables",
        "reconcile the bank statement for July": "bank reconciliation",
    }
    for prompt, label in adjacent.items():
        result = await evaluate(EvaluateRequest(prompt=prompt, actor=officer))
        check(
            f"10. {label} is refused, not coerced",
            result.decision == PolicyDecision.DENY
            and result.request_type == RequestType.UNSUPPORTED,
            f"got {result.decision.value}/{result.request_type.value}"
            + (f" as {result.action.name}" if result.action else ""),
        )
        # 10b. The assertion that would have caught the original bug without
        # depending on a JSON parse error: money arriving must never map to an
        # action that sends money out.
        check(
            f"10b. {label} never maps to an outbound action",
            result.action is None
            or get_action(result.action.name).flow != MoneyFlow.OUT,
            f"mapped to {result.action.name if result.action else '-'}",
        )

    # 10c. A refusal must name the capability. Reporting "missing parameter
    # 'vendor_id'" tells the user to supply a vendor for an action this system
    # does not perform at all — it invites them to retry their way in.
    receipt = await evaluate(
        EvaluateRequest(
            prompt="record a customer payment received for invoice INV-99", actor=officer
        )
    )
    check(
        "10c. the refusal names the capability, not a missing parameter",
        "parameter" not in receipt.reason.lower(),
        f"reason was: {receipt.reason[:90]}",
    )

    # 11. Data requests are refused, not answered out of the policy corpus.
    for prompt in (
        "how much did we spend on travel last month?",
        "who are the employees that are paid higher than 25000?",
    ):
        data = await evaluate(EvaluateRequest(prompt=prompt, actor=officer))
        check(
            f"11. data request refused: {prompt[:38]}",
            data.decision == PolicyDecision.DENY
            and data.request_type == RequestType.DATA,
            f"got {data.decision.value}/{data.request_type.value}",
        )

    # 11b. ...and the policy-question path still works, so the split did not
    # simply reclassify everything as data.
    still_answers = await evaluate(
        EvaluateRequest(prompt="what is our limit for releasing a payment?", actor=officer)
    )
    check(
        "11b. a policy question still answers with citations",
        still_answers.decision == PolicyDecision.ANSWER and bool(still_answers.citations),
        f"got {still_answers.decision.value}, {len(still_answers.citations)} citation(s)",
    )

    # 12. The mapping that must keep working. Every guard above trades false
    # negatives for safety, and the first version of the confirmation pass
    # rejected this — a gate that refuses the thing it exists to allow is broken
    # in a way that no safety assertion would notice.
    for prompt in (
        "pay invoice 8842",
        "release payment for invoice 8842 to Lanka Traders",
        "approve the Lanka Traders bill INV-771",
    ):
        legit = await evaluate(EvaluateRequest(prompt=prompt, actor=officer))
        check(
            f"12. legitimate request still maps: {prompt[:34]}",
            legit.request_type == RequestType.ACTION and legit.action is not None,
            f"got {legit.request_type.value}: {legit.reason[:70]}",
        )

    # 6. The failure that matters most: the judge is down. An outage must never
    # be the reason an action gets through, so simulate one rather than trust the
    # code path by reading it. Both dependencies are stubbed to raise the way a
    # dropped connection does.
    from src.core.policy import judge as judge_module

    async def _judge_is_down(*_a, **_kw):
        raise ConnectionError("simulated: judge unreachable")

    def _qdrant_is_down(*_a, **_kw):
        raise ConnectionError("simulated: Qdrant unreachable")

    real_judge = judge_module.judge
    judge_module.judge = _judge_is_down
    try:
        judge_down = await evaluate(
            EvaluateRequest(
                prompt="release payment for invoice 8842",
                actor=officer,
                context={"amount": 250_000},
            )
        )
    finally:
        judge_module.judge = real_judge

    check(
        "6. judge unreachable denies, never allows",
        judge_down.decision == PolicyDecision.DENY,
        f"got {judge_down.decision.value}: {judge_down.reason}",
    )

    # 6c. A judge that answered, but said nothing usable, is not the same failure.
    # llama3.2:3b returns a bare {"decision": "deny"} — no reason, no citation —
    # and that was denying requests every deterministic check had passed. An
    # empty opinion may escalate to a human; it may not refuse on its own, or the
    # cheapest output a struggling model can produce becomes the gate's verdict.
    async def _judge_says_nothing(*_a, **_kw):
        return judge_module.JudgeResult(
            PolicyDecision.DENY, "No reason supplied by the judge.", [], "stub"
        )

    # 6e. A judge that *does* explain itself must still be able to escalate —
    # the point is to discard noise, not to stop listening.
    async def _judge_objects(*_a, **_kw):
        from src.types.policy import Citation
        return judge_module.JudgeResult(
            PolicyDecision.DENY,
            "Clause 5.2 requires treasury counter-signature for this vendor.",
            [Citation(policy_id="FIN-PAY-2026-003", version="1.0", section="5",
                      title="Payment release authorization", quote="...")],
            "stub",
        )

    judge_module.judge = _judge_says_nothing
    try:
        empty_verdict = await evaluate(
            EvaluateRequest(
                prompt="release payment for invoice 8842",
                actor=manager,
                context={"amount": 250_000},
            )
        )
    finally:
        judge_module.judge = real_judge

    check(
        "6c. an uninformative judge verdict is discarded, not obeyed",
        empty_verdict.decision in (
            PolicyDecision.ALLOW, PolicyDecision.ALLOW_WITH_CONDITIONS
        ),
        f"got {empty_verdict.decision.value}: {empty_verdict.reason[:70]}",
    )
    check(
        "6d. the deterministic checks that passed are still reported",
        any(c.satisfied is True for c in empty_verdict.conditions),
        f"conditions: {[(c.type.value, c.satisfied) for c in empty_verdict.conditions]}",
    )

    judge_module.judge = _judge_objects
    try:
        reasoned = await evaluate(
            EvaluateRequest(
                prompt="release payment for invoice 8842",
                actor=manager,
                context={"amount": 250_000},
            )
        )
    finally:
        judge_module.judge = real_judge

    check(
        "6e. a reasoned judge objection still escalates to review",
        reasoned.decision == PolicyDecision.REVIEW,
        f"got {reasoned.decision.value}: {reasoned.reason[:70]}",
    )

    retriever = get_policy_retriever()
    real_retrieve = retriever.retrieve
    retriever.retrieve = _qdrant_is_down
    try:
        store_down = await evaluate(
            EvaluateRequest(prompt="release payment for invoice 8842", actor=officer)
        )
    finally:
        retriever.retrieve = real_retrieve

    check(
        "6b. policy store unreachable denies, never allows",
        store_down.decision == PolicyDecision.DENY,
        f"got {store_down.decision.value}: {store_down.reason}",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--retrieval-only", action="store_true",
        help="run only the cases that need Qdrant, skipping those that need the LLM",
    )
    args = parser.parse_args()

    print("=" * 76)
    print("POLICY GATE — GOLDEN CASES")
    print("=" * 76)

    print("\n-- retrieval --")
    retrieval_cases()

    if not args.retrieval_only:
        print("\n-- full gate --")
        asyncio.run(gate_cases())

    failures = [r for r in _results if r[0] == FAIL]
    print("\n" + "=" * 76)
    print(f"{len(_results) - len(failures)}/{len(_results)} passed")
    for _, name, detail in failures:
        print(f"  FAILED: {name}\n          {detail}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

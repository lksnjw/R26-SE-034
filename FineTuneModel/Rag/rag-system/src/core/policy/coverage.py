"""
Coverage model — which questions the rule set must be able to answer.

WHY THIS EXISTS
"Is our policy corpus complete?" is unanswerable as asked, and counting documents
does not answer it: a hundred documents that never mention duplicate invoices
leave duplicate invoices ungoverned. But the question becomes finite once you
notice that the action registry bounds it. There are N registered actions, and a
finance decision turns on a small, listable set of dimensions. The product of the
two is the space that has to be covered, and gaps in it can be enumerated.

A missing dimension is not a retrieval failure. Retrieval will work perfectly and
return every rule that exists — and the judge, seeing nothing about duplicates,
will approve the second payment of the same invoice. That is why this module
reports on the *corpus*, not on the retriever.

HOW COVERAGE IS DETECTED, AND ITS LIMITS
Two kinds of signal, and they are not equally trustworthy:

  • STRUCTURED (authority, threshold, segregation) — read from front-matter
    fields. Reliable: the field is either there or it is not.

  • TEXTUAL (everything else) — keyword match against clause text. This is a
    heuristic and it is wrong in both directions: a clause can mention "duplicate"
    in passing without governing duplicates, and a clause can govern them in words
    this module does not know.

So a "covered" verdict here means *a human should check this looks right*, and an
"uncovered" verdict means *nobody has written this rule down, or it is phrased in
a way the audit cannot see*. Neither is proof. The value is in turning a vague
worry into a specific list to take to whoever owns finance policy.
"""
from dataclasses import dataclass, field
from typing import Callable

from src.core.actions.action_registry import ActionName, ActionSpec, all_actions
from src.core.policy.rule_engine import SEGREGATION_OF_DUTIES

# Shorthand for the action sets below.
_A = ActionName


@dataclass(frozen=True)
class Dimension:
    """One question a rule set must answer for a given action."""

    key: str
    title: str
    # What goes wrong when no rule covers this. Printed in the gap report, because
    # a gap list without consequences gets prioritised by whoever shouts loudest.
    risk: str
    applies_to: frozenset[ActionName]
    keywords: tuple[str, ...] = ()
    structured: Callable[[object], bool] | None = None

    def covered_by(self, chunk) -> bool:
        """True if this clause appears to address the dimension."""
        if self.structured is not None and self.structured(chunk.meta):
            return True
        if not self.keywords:
            return False
        text = f"{chunk.meta.title} {chunk.text}".lower()
        return any(word in text for word in self.keywords)


def _financial() -> frozenset[ActionName]:
    return frozenset(a.name for a in all_actions() if a.financial)


def _all() -> frozenset[ActionName]:
    return frozenset(a.name for a in all_actions())


def _segregated() -> frozenset[ActionName]:
    return frozenset(a.name for a in all_actions() if a.self_approval_forbidden)


DIMENSIONS: list[Dimension] = [
    Dimension(
        key="authority",
        title="Who may authorize it",
        risk="any employee's request looks as legitimate as a manager's",
        applies_to=_all(),
        structured=lambda meta: bool(meta.requires_role),
        keywords=("approv", "authoris", "authoriz", "delegat", "signator"),
    ),
    Dimension(
        key="threshold",
        title="Value limit that changes who must approve",
        risk="a 50,000 payment and a 50,000,000 payment are treated identically",
        applies_to=_financial(),
        structured=lambda meta: meta.threshold_value is not None,
        keywords=("exceed", "above", "limit", "up to", "threshold"),
    ),
    Dimension(
        key="segregation",
        title="Separation of requester and approver",
        risk="the person who raises an invoice can also pay it",
        applies_to=_segregated(),
        structured=lambda meta: SEGREGATION_OF_DUTIES in meta.enforces,
        keywords=("segregation", "same person", "own claim", "self-approv", "raised the"),
    ),
    Dimension(
        key="evidence",
        title="Supporting documentation required",
        risk="a claim with no receipt and a claim with one are indistinguishable",
        applies_to=frozenset({
            _A.APPROVE_INVOICE, _A.APPROVE_PURCHASE_ORDER, _A.APPROVE_TRAVEL_CLAIM,
            _A.REIMBURSE_EXPENSE, _A.POST_JOURNAL_ENTRY, _A.ISSUE_CREDIT_NOTE,
        }),
        keywords=("evidence", "receipt", "supporting document", "attach",
                  "substantiat", "three-way match", "goods receipt"),
    ),
    Dimension(
        key="duplicate",
        title="Duplicate and repeat submissions",
        risk="the same invoice is paid twice and each payment passes every other check",
        applies_to=frozenset({
            _A.APPROVE_INVOICE, _A.RELEASE_PAYMENT, _A.APPROVE_TRAVEL_CLAIM,
            _A.REIMBURSE_EXPENSE, _A.ISSUE_CREDIT_NOTE,
        }),
        keywords=("duplicate", "already paid", "previously submitted", "resubmit",
                  "same invoice", "double payment"),
    ),
    Dimension(
        key="period",
        title="Accounting period and backdating",
        risk="entries land in a closed period and restate a signed-off result",
        applies_to=frozenset({
            _A.POST_JOURNAL_ENTRY, _A.ISSUE_CREDIT_NOTE, _A.APPROVE_BUDGET_TRANSFER,
            _A.APPROVE_INVOICE,
        }),
        keywords=("period", "backdat", "closed", "year-end", "financial year",
                  "posting date", "cut-off"),
    ),
    Dimension(
        key="budget",
        title="Funds availability",
        risk="commitments are approved against a cost centre with nothing left in it",
        applies_to=frozenset({
            _A.APPROVE_PURCHASE_ORDER, _A.APPROVE_BUDGET_TRANSFER, _A.APPROVE_INVOICE,
        }),
        keywords=("budget", "allocation", "cost centre", "cost center", "funds available",
                  "unencumbered"),
    ),
    Dimension(
        key="counterparty",
        title="Vendor standing and recent changes",
        risk="payment goes to a blocked vendor, or to a bank account changed yesterday",
        applies_to=frozenset({
            _A.RELEASE_PAYMENT, _A.APPROVE_INVOICE, _A.APPROVE_PURCHASE_ORDER,
            _A.UPDATE_VENDOR_BANK_DETAILS,
        }),
        keywords=("vendor", "supplier", "blocked", "sanction", "blacklist",
                  "bank detail", "counterparty", "beneficiary"),
    ),
    Dimension(
        key="currency",
        title="Foreign currency and cross-border payments",
        risk="an overseas transfer clears with none of the extra scrutiny it needs",
        applies_to=frozenset({
            _A.RELEASE_PAYMENT, _A.APPROVE_PURCHASE_ORDER, _A.APPROVE_INVOICE,
        }),
        keywords=("currency", "foreign", "cross-border", "exchange rate", "overseas",
                  "remittance", "usd", "eur"),
    ),
    Dimension(
        key="disclosure",
        title="What may be shown in the reply",
        risk="a confirmation echoes a full bank account, breaching privacy though the action was allowed",
        applies_to=frozenset({
            _A.VIEW_LEDGER_ENTRY, _A.UPDATE_VENDOR_BANK_DETAILS, _A.RELEASE_PAYMENT,
        }),
        keywords=("disclos", "mask", "redact", "personal data", "confidential",
                  "privacy", "need-to-know"),
    ),
]


@dataclass
class ActionCoverage:
    action: str
    covered: dict[str, list[str]] = field(default_factory=dict)   # dimension → citations
    missing: list[Dimension] = field(default_factory=list)
    has_specific_policy: bool = False

    @property
    def score(self) -> str:
        total = len(self.covered) + len(self.missing)
        return f"{len(self.covered)}/{total}"


def dimensions_for(spec: ActionSpec) -> list[Dimension]:
    return [d for d in DIMENSIONS if spec.name in d.applies_to]


def analyse(governing_chunks: dict[str, list]) -> list[ActionCoverage]:
    """
    Score each action's governing clauses against the dimensions that apply to it.

    `governing_chunks` maps action name → the chunks retrieved by filter alone.
    Chunks found by similarity must not be passed in: they are not coverage.
    """
    report = []
    for spec in all_actions():
        chunks = governing_chunks.get(spec.name.value, [])
        result = ActionCoverage(
            action=spec.name.value,
            has_specific_policy=any(
                spec.name.value in c.meta.applies_to_actions for c in chunks
            ),
        )
        for dimension in dimensions_for(spec):
            citations = [c.meta.citation for c in chunks if dimension.covered_by(c)]
            if citations:
                result.covered[dimension.key] = sorted(set(citations))
            else:
                result.missing.append(dimension)
        report.append(result)
    return report

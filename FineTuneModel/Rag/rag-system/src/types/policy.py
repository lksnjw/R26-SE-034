"""
Policy domain types.

`PolicyMeta` is the *internal* normalised view of a policy chunk's metadata.
It is deliberately decoupled from whatever the data-transport layer actually
writes into Qdrant — that external shape is not finalised yet, so all mapping
from their payload into this model happens in one place:
`src/core/policy/payload_adapter.py`.

Nothing outside that adapter should reference their raw field names.
"""
from enum import Enum
from typing import Any

# pyrefly: ignore [missing-import]
from pydantic import BaseModel, Field


class RiskLevel(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class DocType(str, Enum):
    """
    Distinguishes governing rules from ordinary company data.

    Without this, an employee's own salary record could be retrieved and handed
    to the judge as if it were policy authority.
    """
    POLICY = "policy"
    RULE = "rule"
    PRIVACY_POLICY = "privacy_policy"
    COMPANY_DATA = "company_data"
    UNKNOWN = "unknown"

    @property
    def is_governing(self) -> bool:
        """True for chunks that may be used as authority in a decision."""
        return self in (DocType.POLICY, DocType.RULE, DocType.PRIVACY_POLICY)


class ThresholdUnit(str, Enum):
    PERCENT = "percent"
    ABSOLUTE = "absolute"
    DAYS = "days"


class PolicyMeta(BaseModel):
    """
    Normalised metadata for one retrieved policy chunk.

    `applies_to_actions` holds names from `core.actions.action_registry` and is
    what makes deterministic retrieval possible: the governing rules for an
    action are fetched by database predicate, not by hoping similarity ranked
    them into the top-k.
    """
    policy_id: str
    doc_type: DocType = DocType.UNKNOWN
    title: str = ""
    applies_to_actions: list[str] = Field(default_factory=list)
    risk_level: RiskLevel = RiskLevel.MEDIUM
    mandatory: bool = False              # always retrieved, ignores similarity
    version: str = "1.0"
    effective_date: str | None = None
    expires_date: str | None = None
    is_current: bool = True              # False ⇒ superseded, must not decide
    section: str | None = None           # clause ref, e.g. "2.4", for citation
    source_document: str | None = None

    # Optional structured conditions. When present these are evaluated in Python
    # rather than by the judge — a model comparing 15% against a 20% threshold is
    # unreliable in a way that an arithmetic comparison is not.
    threshold_value: float | None = None
    threshold_unit: ThresholdUnit | None = None
    requires_role: list[str] = Field(default_factory=list)

    # Which deterministic checks this clause is the authority for, e.g.
    # ["segregation_of_duties"]. Without it the engine would have to guess which
    # retrieved clause a code-enforced denial should cite, and a denial citing
    # the wrong policy is worse than one citing none — it sends the requester to
    # a rule that does not say what they were told it says.
    #
    # Two accepted shapes, and the difference matters:
    #   ["segregation_of_duties"]           the DOCUMENT is the authority
    #   {"segregation_of_duties": "2"}      clause §2 is the authority
    # A bare list is inherited by every chunk of the document, so the engine can
    # only pick whichever tagged chunk retrieval returned first. That produced a
    # segregation denial citing "§3 Evidence and authority" — the right policy,
    # the wrong clause, quoting text about something else entirely. The mapping
    # form is authored per clause and lands the tag on one chunk only.
    enforces: list[str] | dict[str, str] = Field(default_factory=list)

    # False when the ERP schema has no table behind the action this policy
    # governs — checked against nmdra/mockerp's migrations on 2026-08-30, mirrored
    # in fixtures/erp_schema/. Two documents are wholly in that position:
    # FIN-BUD-2026-007 (no budgets table exists) and FIN-VND-2026-004 (`suppliers`
    # carries no bank columns). Credit notes are equally unbacked but have no
    # document of their own — they are a section inside FIN-GL-2026-006 and
    # FIN-DUP-2026-009, both of which govern backed actions too, so the flag would
    # be wrong either way there; the front-matter comment carries it instead.
    #
    # All are kept deliberately (the gate is not limited to what is built yet),
    # but the distinction has to live in the payload rather than in a comment:
    # "this rule governs nothing the ERP can currently do" is exactly the kind of
    # thing that is forgotten between writing the corpus and defending it.
    erp_backed: bool = True

    # Reject unknown keys: front-matter is built with **kwargs, and a misspelled
    # tag (`applies_to_tools` for `applies_to_actions`) would otherwise be dropped
    # silently — leaving a policy that never matches anything, with no error.
    model_config = {"extra": "forbid"}

    @property
    def citation(self) -> str:
        """Stable reference for the audit trail."""
        base = f"{self.policy_id}@{self.version}"
        return f"{base}#{self.section}" if self.section else base

    @property
    def has_structured_condition(self) -> bool:
        return self.threshold_value is not None or bool(self.requires_role)

    @property
    def enforced_checks(self) -> list[str]:
        """The check names, whichever authoring shape `enforces` used."""
        return list(self.enforces)          # dict iterates its keys

    @property
    def enforced_sections(self) -> dict[str, str | None]:
        """check -> the clause that states it, or None when authored as a bare list."""
        if isinstance(self.enforces, dict):
            return {k: str(v) for k, v in self.enforces.items()}
        return {check: None for check in self.enforces}

    def to_payload(self) -> dict[str, Any]:
        """
        Flat dict for a Qdrant point payload.

        Used only by the offline fixture generator — production ingestion is
        owned by the data-transport layer, not by this module.
        """
        return {
            "doc_type": self.doc_type.value,
            "policy_id": self.policy_id,
            "title": self.title,
            "applies_to_actions": self.applies_to_actions,
            "risk_level": self.risk_level.value,
            "mandatory": self.mandatory,
            "version": self.version,
            "effective_date": self.effective_date,
            "expires_date": self.expires_date,
            "is_current": self.is_current,
            "section": self.section,
            "source_document": self.source_document,
            "threshold_value": self.threshold_value,
            "threshold_unit": self.threshold_unit.value if self.threshold_unit else None,
            "requires_role": self.requires_role,
            # Always a flat list on the wire, whatever shape the front-matter
            # used. `build_policy_documents` narrows it per chunk; the published
            # payload contract (§2.3) stays unchanged for the other team.
            "enforces": self.enforced_checks,
        }


class PolicyDecision(str, Enum):
    ALLOW = "allow"
    ALLOW_WITH_CONDITIONS = "allow_with_conditions"   # caller must satisfy `conditions`
    DENY = "deny"
    REVIEW = "review"                    # escalate to a human
    # Nothing was requested to be done — the response carries knowledge only.
    # Distinct from REVIEW so the caller never queues a question for approval.
    ANSWER = "answer"


class ConditionType(str, Enum):
    THRESHOLD = "threshold"              # a stated limit the caller must compare against
    ROLE = "role"                        # the actor must hold one of these roles
    SEGREGATION = "segregation"          # actor must not be the raiser/beneficiary
    EVIDENCE = "evidence"                # a document or record must exist


class Condition(BaseModel):
    """
    Something that must be true before the caller may execute.

    Conditions exist because this module holds policies, not ERP data. A rule
    states its limit; whether *this* transaction is under that limit depends on
    facts only the ERP has. Rather than assume, we hand the comparison back with
    the limit attached — the caller checks it against the record.

    `satisfied` is True only when the fact was supplied in the request and the
    comparison passed here. None means "not checkable with what we were given",
    which is never the same as True.
    """
    type: ConditionType
    description: str                     # human-readable, shown to the requester
    source: str                          # policy_id@version#section — the authority
    field: str | None = None             # ERP fact to compare, e.g. "amount"
    operator: str | None = None          # "<=", ">=", "in"
    value: Any = None                    # the limit as stated by the rule
    unit: str | None = None              # percent / absolute / days
    else_require: list[str] = Field(default_factory=list)   # what applies if it fails
    satisfied: bool | None = None

    @property
    def blocks_execution(self) -> bool:
        """Anything not positively satisfied must be resolved by the caller."""
        return self.satisfied is not True


class Citation(BaseModel):
    """One policy chunk relied upon, in a form an auditor can follow back."""
    policy_id: str
    version: str
    section: str | None = None
    title: str = ""
    quote: str = ""                      # the clause text actually relied upon

    @property
    def ref(self) -> str:
        base = f"{self.policy_id}@{self.version}"
        return f"{base}#{self.section}" if self.section else base


class PolicyVerdict(BaseModel):
    """
    Outcome of the policy gate.

    `allowed_actions` is consumed by the execution gate: approving an intent is
    not the same as authorising whichever action the model then selected.
    """
    decision: PolicyDecision
    reason: str
    allowed_actions: list[str] = Field(default_factory=list)
    cited_policies: list[str] = Field(default_factory=list)   # policy_id@version#section
    citations: list[Citation] = Field(default_factory=list)
    conditions: list[Condition] = Field(default_factory=list)
    retrieved_count: int = 0             # how many chunks the judge actually saw
    judge_model: str | None = None       # recorded for audit reproducibility

    @property
    def is_allowed(self) -> bool:
        """
        Unconditionally executable. ALLOW_WITH_CONDITIONS is deliberately excluded:
        the caller must clear `conditions` first, and a caller that treats the two
        as equivalent is exactly the bug this distinction exists to prevent.
        """
        return self.decision == PolicyDecision.ALLOW

    @property
    def unmet_conditions(self) -> list[Condition]:
        return [c for c in self.conditions if c.blocks_execution]

    @classmethod
    def denied(cls, reason: str, **kw: Any) -> "PolicyVerdict":
        """Fail-closed constructor — used whenever the judge cannot be trusted."""
        return cls(decision=PolicyDecision.DENY, reason=reason, **kw)

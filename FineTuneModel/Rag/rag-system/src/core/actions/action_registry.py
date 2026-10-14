"""
Action registry — the canonical vocabulary of every finance action this module gates.

This registry is a PUBLISHED CONTRACT, not an internal detail:

  • The data-transport layer tags each policy chunk with `applies_to_actions`
    drawn from these exact names.  A typo there means a policy silently stops
    applying, so the names must be treated as a stable, versioned interface.
  • Intent extraction is constrained to these names — the model cannot invent
    an action that isn't registered.
  • The caller (the ERP front-end) executes only actions named here, and only
    after this module has returned a verdict for that exact name.

Adding an action is a coordinated change: register it here, then have the
policy corpus re-tagged, or the new action runs with no policy coverage.

SCOPE: the ERP finance module — accounts payable, payments, expenses, the
general ledger, and budget control.  Payroll and HR actions are out of scope
and deliberately absent.
"""
from enum import Enum
from typing import Any

# pyrefly: ignore [missing-import]
from pydantic import BaseModel

from src.types.policy import RiskLevel

# 0.2.0 — replaced the HR vocabulary with the finance module vocabulary.
# Any policy still tagged with the 0.1.x HR names governs nothing.
REGISTRY_VERSION = "0.2.0"


class ActionName(str, Enum):
    """Canonical action identifiers. Values are what the policy corpus tags against."""

    # ── Accounts payable ──────────────────────────────────────────────────────
    APPROVE_INVOICE = "approve_invoice"
    APPROVE_PURCHASE_ORDER = "approve_purchase_order"
    ISSUE_CREDIT_NOTE = "issue_credit_note"

    # ── Disbursement ──────────────────────────────────────────────────────────
    RELEASE_PAYMENT = "release_payment"
    UPDATE_VENDOR_BANK_DETAILS = "update_vendor_bank_details"

    # ── Employee expenses ─────────────────────────────────────────────────────
    APPROVE_TRAVEL_CLAIM = "approve_travel_claim"
    REIMBURSE_EXPENSE = "reimburse_expense"

    # ── General ledger and budget ─────────────────────────────────────────────
    POST_JOURNAL_ENTRY = "post_journal_entry"
    APPROVE_BUDGET_TRANSFER = "approve_budget_transfer"
    VIEW_LEDGER_ENTRY = "view_ledger_entry"


class MoneyFlow(str, Enum):
    """
    Which way money moves, from this organisation's point of view.

    Recorded because an extractor asked "which of these ten fits best?" will
    always answer with one of the ten. A request to record an incoming customer
    receipt was mapped to `release_payment` — an outbound disbursement — with high
    confidence, and the parameters validated cleanly. Direction is the one
    property of a finance action that must never be inferred from wording.
    """
    OUT = "out"          # money leaves the organisation
    IN = "in"            # money arrives
    NEUTRAL = "neutral"  # no movement: reads, reclassifications, commitments


class ActionSpec(BaseModel):
    """
    One registered action.

    `params_schema` is JSON Schema and is enforced deterministically after intent
    extraction — the model proposes parameters, this schema decides whether they
    are even well-formed before any policy reasoning happens.
    """
    name: ActionName
    description: str
    params_schema: dict[str, Any]
    risk: RiskLevel
    flow: MoneyFlow = MoneyFlow.NEUTRAL
    financial: bool = False          # moves money → stricter thresholds apply
    mutates_pii: bool = False        # touches personal/bank data → privacy policy applies
    # Segregation of duties: the actor may not approve a document they raised,
    # or one that pays them. Checked in the rule engine against actor identity.
    self_approval_forbidden: bool = True

    @property
    def is_mutation(self) -> bool:
        return self.name != ActionName.VIEW_LEDGER_ENTRY


def _amount() -> dict[str, Any]:
    return {
        "type": "number",
        "exclusiveMinimum": 0,
        "description": "Transaction amount in the document currency",
    }


_SPECS: dict[ActionName, ActionSpec] = {
    ActionName.APPROVE_INVOICE: ActionSpec(
        name=ActionName.APPROVE_INVOICE,
        description="Approve a supplier invoice for payment.",
        flow=MoneyFlow.OUT,
        risk=RiskLevel.HIGH,
        financial=True,
        params_schema={
            "type": "object",
            "properties": {
                "invoice_id": {"type": "string", "minLength": 1},
                "vendor_id": {"type": "string"},
                "amount": _amount(),
                "currency": {"type": "string", "minLength": 3, "maxLength": 3},
                "cost_centre": {"type": "string"},
            },
            "required": ["invoice_id"],
            "additionalProperties": False,
        },
    ),
    ActionName.APPROVE_PURCHASE_ORDER: ActionSpec(
        name=ActionName.APPROVE_PURCHASE_ORDER,
        description="Approve a purchase order committing the organization to a spend.",
        flow=MoneyFlow.OUT,
        risk=RiskLevel.HIGH,
        financial=True,
        params_schema={
            "type": "object",
            "properties": {
                "purchase_order_id": {"type": "string", "minLength": 1},
                "vendor_id": {"type": "string"},
                "amount": _amount(),
                "currency": {"type": "string", "minLength": 3, "maxLength": 3},
                "cost_centre": {"type": "string"},
            },
            "required": ["purchase_order_id"],
            "additionalProperties": False,
        },
    ),
    ActionName.ISSUE_CREDIT_NOTE: ActionSpec(
        name=ActionName.ISSUE_CREDIT_NOTE,
        description="Issue a credit note reversing or reducing a previously booked charge.",
        flow=MoneyFlow.NEUTRAL,
        risk=RiskLevel.HIGH,
        financial=True,
        params_schema={
            "type": "object",
            "properties": {
                "invoice_id": {"type": "string", "minLength": 1},
                "amount": _amount(),
                "reason": {"type": "string", "minLength": 1},
            },
            # A credit note without a reason is indistinguishable from
            # concealment of an erroneous charge.
            "required": ["invoice_id", "amount", "reason"],
            "additionalProperties": False,
        },
    ),
    ActionName.RELEASE_PAYMENT: ActionSpec(
        name=ActionName.RELEASE_PAYMENT,
        description="Release funds against an approved invoice or payment run.",
        flow=MoneyFlow.OUT,
        risk=RiskLevel.CRITICAL,
        financial=True,
        params_schema={
            "type": "object",
            "properties": {
                "invoice_id": {"type": "string"},
                "payment_run_id": {"type": "string"},
                "vendor_id": {"type": "string"},
                "amount": _amount(),
                "currency": {"type": "string", "minLength": 3, "maxLength": 3},
                "value_date": {"type": "string", "format": "date"},
            },
            # Exactly one target — "pay it" against an ambiguous reference must
            # not be silently resolved to whichever document looked closest.
            "oneOf": [
                {"required": ["invoice_id"]},
                {"required": ["payment_run_id"]},
            ],
            "additionalProperties": False,
        },
    ),
    ActionName.UPDATE_VENDOR_BANK_DETAILS: ActionSpec(
        name=ActionName.UPDATE_VENDOR_BANK_DETAILS,
        description="Change the bank account a vendor is paid into.",
        flow=MoneyFlow.OUT,
        risk=RiskLevel.CRITICAL,
        financial=True,
        mutates_pii=True,
        params_schema={
            "type": "object",
            "properties": {
                "vendor_id": {"type": "string", "minLength": 1},
                "account_number": {"type": "string", "minLength": 1},
                "bank_code": {"type": "string"},
                "account_name": {"type": "string"},
            },
            "required": ["vendor_id", "account_number"],
            "additionalProperties": False,
        },
    ),
    ActionName.APPROVE_TRAVEL_CLAIM: ActionSpec(
        name=ActionName.APPROVE_TRAVEL_CLAIM,
        description="Approve an employee travel expense claim for reimbursement.",
        flow=MoneyFlow.OUT,
        risk=RiskLevel.MEDIUM,
        financial=True,
        params_schema={
            "type": "object",
            "properties": {
                "claim_id": {"type": "string", "minLength": 1},
                "employee_id": {"type": "string"},
                "amount": _amount(),
                "travel_permit_id": {"type": "string"},
            },
            "required": ["claim_id"],
            "additionalProperties": False,
        },
    ),
    ActionName.REIMBURSE_EXPENSE: ActionSpec(
        name=ActionName.REIMBURSE_EXPENSE,
        description="Pay an approved expense claim back to an employee.",
        flow=MoneyFlow.OUT,
        risk=RiskLevel.HIGH,
        financial=True,
        params_schema={
            "type": "object",
            "properties": {
                "claim_id": {"type": "string", "minLength": 1},
                "employee_id": {"type": "string"},
                "amount": _amount(),
            },
            "required": ["claim_id"],
            "additionalProperties": False,
        },
    ),
    ActionName.POST_JOURNAL_ENTRY: ActionSpec(
        name=ActionName.POST_JOURNAL_ENTRY,
        description="Post a manual journal entry to the general ledger.",
        flow=MoneyFlow.NEUTRAL,
        risk=RiskLevel.HIGH,
        financial=True,
        params_schema={
            "type": "object",
            "properties": {
                "debit_account": {"type": "string", "minLength": 1},
                "credit_account": {"type": "string", "minLength": 1},
                "amount": _amount(),
                "period": {"type": "string", "description": "Accounting period, e.g. 2026-07"},
                "narration": {"type": "string", "minLength": 1},
            },
            "required": ["debit_account", "credit_account", "amount", "narration"],
            "additionalProperties": False,
        },
    ),
    ActionName.APPROVE_BUDGET_TRANSFER: ActionSpec(
        name=ActionName.APPROVE_BUDGET_TRANSFER,
        description="Move budget between cost centres or budget lines.",
        flow=MoneyFlow.NEUTRAL,
        risk=RiskLevel.MEDIUM,
        financial=True,
        params_schema={
            "type": "object",
            "properties": {
                "from_cost_centre": {"type": "string", "minLength": 1},
                "to_cost_centre": {"type": "string", "minLength": 1},
                "amount": _amount(),
                "percentage": {"type": "number", "exclusiveMinimum": 0, "maximum": 100},
                "reason": {"type": "string"},
            },
            "required": ["from_cost_centre", "to_cost_centre"],
            "additionalProperties": False,
        },
    ),
    ActionName.VIEW_LEDGER_ENTRY: ActionSpec(
        name=ActionName.VIEW_LEDGER_ENTRY,
        description="Read ledger entries, vendor records, or payment history.",
        flow=MoneyFlow.NEUTRAL,
        risk=RiskLevel.MEDIUM,
        mutates_pii=True,
        self_approval_forbidden=False,   # reading is not approving
        params_schema={
            "type": "object",
            "properties": {
                "account": {"type": "string"},
                "vendor_id": {"type": "string"},
                "cost_centre": {"type": "string"},
                "period": {"type": "string"},
            },
            "additionalProperties": False,
        },
    ),
}


def get_action(name: str) -> ActionSpec | None:
    """Look up a registered action. Returns None for anything unregistered."""
    try:
        return _SPECS[ActionName(name)]
    except (ValueError, KeyError):
        return None


def all_actions() -> list[ActionSpec]:
    return list(_SPECS.values())


def action_names() -> list[str]:
    """The exact strings the policy corpus must tag against."""
    return [a.value for a in ActionName]

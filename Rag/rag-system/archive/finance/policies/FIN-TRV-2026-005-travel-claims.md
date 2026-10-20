---
policy_id: FIN-TRV-2026-005
doc_type: policy
title: Travel claims and expense reimbursement
applies_to_actions: [approve_travel_claim, reimburse_expense]
risk_level: medium
mandatory: false
version: "1.0"
effective_date: "2026-01-01"
is_current: true
source_document: travel_claim_policy.pdf
# Backed, but only partly: expense_claims and expense_claim_lines are real ERP
# documents. A travel permit is not — no such table exists — so clause 2.1 can
# never be verified from a record and comes back satisfied: null rather than as
# a pass. That is the correct outcome, not a gap to paper over: an unverifiable
# control is a condition on the approval, not a check that succeeded.
threshold_value: 14
threshold_unit: days
requires_role: [department_manager, finance_editor]
---

## 1. Scope

This policy governs the approval and reimbursement of employee travel and business
expense claims submitted through the ERP travel and finance process.

## 2. Travel permit requirement

2.1 A travel claim may be approved only where a travel permit or travel request was
created in the ERP system before the travel commenced. A claim submitted without a
valid permit reference must be rejected.

2.2 Where actual travel differed from the approved permit in destination or
duration, the variance must be recorded and approved by the department head before
the claim is processed.

## 3. Submission window

3.1 A travel claim must be submitted within 14 calendar days of the completion of
travel. A claim submitted after that window may be approved only with the written
concurrence of the Finance Manager, recorded against the claim.

3.2 A claim submitted more than 90 calendar days after the completion of travel must
not be approved through any channel and must be referred to the Finance Control Unit.

## 4. Evidence

4.1 Every claimed expense must be supported by an original receipt or a valid tax
invoice. Expenses without supporting evidence must not be reimbursed, irrespective
of amount.

4.2 Meal allowances claimed at the standard daily rate do not require individual
receipts, but the days claimed must fall within the approved travel dates.

4.3 Expenses of a personal nature, entertainment without prior approval, and any
expense already settled directly by the organization must not be reimbursed.

## 5. Reimbursement

5.1 Reimbursement is made only to the bank account recorded for the employee in the
ERP system. Reimbursement to any other account must be refused.

5.2 An approved claim must be reimbursed within 30 calendar days of approval.

5.3 An employee may not approve their own travel claim, nor the claim of a person to
whom they directly report, regardless of amount.

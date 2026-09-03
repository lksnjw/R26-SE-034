---
policy_id: FIN-PAY-2026-003
doc_type: policy
title: Payment release authorization
applies_to_actions: [release_payment]
risk_level: critical
mandatory: false
version: "2.0"
effective_date: "2026-01-01"
is_current: true
source_document: treasury_controls_manual.pdf
# AUTHORED, unlike FIN-AP-2026-002's 100,000. The ERP's approval_rules table
# carries rows for 'Purchase Order' and 'Leave Application' only — there is no
# 'Payment Entry' chain, and payment_entries has no approval_request_id. So a
# payment in this ERP is submitted, not approved, and this limit is a control the
# corpus states rather than one the schema already enforces. Say so if asked.
threshold_value: 1000000
threshold_unit: absolute
requires_role: [finance_editor, finance_manager]
---

## 1. Scope

This policy governs the release of funds against submitted invoices, payment runs,
and manual payment instructions.

All values in this policy are stated in Sri Lanka Rupees in major units. Payment
records hold amounts in minor units (`paid_amount_minor`), and a value taken from
that column must be converted before it is compared against the limits below.

## 2. Preconditions

2.1 Funds may be released only against an invoice that has been submitted under the
invoice approval policy. An invoice still in Draft, or one recorded as Cancelled,
must not be paid, and an invoice already recorded as Paid must not be paid a second
time.

2.2 The beneficiary account used must be the account recorded for that supplier
before the payment was requested. A payment must never be released to account
details supplied in the payment request itself. Where no account is recorded for the
supplier, the payment is held rather than released against details supplied with the
instruction.

2.3 A payment must not be released where the supplier's bank details were changed
within the preceding two working days, except as permitted by the vendor bank detail
policy.

## 3. Authorization

3.1 Payments of 1,000,000 or less may be released on the authority of a single
Finance Editor.

3.2 Payments exceeding 1,000,000 require dual authorization: two authorized
signatories, of whom at least one must hold the Finance Manager role, must each
record their approval against the payment before funds move.

3.3 The dual authorization requirement in clause 3.2 may not be satisfied by the
same person acting in two capacities, and may not be waived by reason of urgency,
supplier pressure, or an imminent payment run cut-off.

## 4. Payment runs

4.1 A payment run must be released as a whole. Individual payments must not be added
to a run after its approval.

4.2 A payment released outside a scheduled run must record the reason for the
exception, and such payments are reviewed monthly by the Finance Control Unit.

4.3 Same-day value payments require Finance Manager authorization regardless of
amount.

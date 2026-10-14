---
policy_id: FIN-DUP-2026-009
doc_type: policy
title: Duplicate and repeat submissions
applies_to_actions: [approve_invoice, release_payment, approve_travel_claim, reimburse_expense, issue_credit_note]
risk_level: high
mandatory: false
version: "1.0"
effective_date: "2026-01-01"
is_current: true
source_document: accounts_payable_controls_manual.pdf
# No threshold_value or requires_role: duplication is not a question of amount or
# rank. A duplicate of a small claim is as much a loss as a duplicate of a large
# one, and every role that may submit may also submit twice.
---

## 1. Scope

This policy governs the detection and handling of repeat submissions across
accounts payable, expense reimbursement, and credit note issuance. It applies
whenever a document is presented for approval or payment that may already have
been processed, in whole or in part.

A duplicate submission passes every other control in this manual. The invoice is
genuine, the vendor is legitimate, the approver is authorised and the amount is
within limits — each check succeeds, and the organisation pays twice. Detection
must therefore be a distinct step and not a by-product of the other controls.

## 2. Duplicate invoices

2.1 Before an invoice is approved, it must be checked against invoices already
recorded for the same vendor. An invoice is a suspected duplicate where the vendor
and invoice number match an existing record, or where the vendor, amount, and
invoice date all match an existing record even though the invoice number differs.

2.2 A suspected duplicate must not be approved on the basis that the earlier
record is unpaid, cancelled, or in dispute. The earlier record must be examined
and the two reconciled first.

2.3 Where a vendor legitimately re-issues an invoice — following a correction, a
change of tax details, or a lost original — the re-issued invoice may be approved
only if the original is cancelled in the same action. Both documents must carry a
reference to the other.

## 3. Repeat payment of an approved invoice

3.1 A payment must not be released against an invoice that already has a payment
recorded against it, whether that payment is settled, in progress, or failed. A
failed payment must be reversed and re-raised, never re-released.

3.2 Where a payment run is interrupted, restarted, or re-uploaded to the banking
channel, the run must be reconciled against the bank before any of its items are
released again. Re-running an interrupted payment file without reconciliation is
the most common cause of duplicate outbound payment and is prohibited regardless
of the urgency claimed or the seniority of the person requesting it.

3.3 Manual payment instructions raised outside the normal run are checked against
the pending run for the same vendor before release.

## 4. Repeat expense and travel claims

4.1 An expense may be claimed once. A claim must be checked against claims already
submitted by the same employee for overlapping dates, and against claims submitted
by other employees for the same event where costs may have been shared.

4.2 A receipt that has already been used to support a paid claim must not support a
second claim, including a claim submitted under a different expense category or in a
different reporting period.

4.3 A claim rejected for missing evidence may be resubmitted once the evidence is
supplied. This is a resubmission and not a duplicate, and the original claim
reference must be quoted.

## 5. Credit notes

5.1 A credit note must not be issued against an invoice that already carries a
credit note for the same charge. Partial credits against a single invoice are
permitted only where together they do not exceed the invoice value.

5.2 A credit note issued to correct a duplicate payment must reference the duplicate
and must be recorded against the same cost centre as the original charge.

## 6. Handling a suspected duplicate

6.1 Where duplication is suspected but not confirmed, the action must be held for
review rather than approved or rejected. A suspected duplicate that is rejected
outright leaves a genuine unpaid invoice with no visible trail, which is a
different failure and not a safer one.

6.2 A confirmed duplicate must be recorded as such, with a reference to the
original document, so that the vendor's account reconciles and the same document
is not presented a third time.

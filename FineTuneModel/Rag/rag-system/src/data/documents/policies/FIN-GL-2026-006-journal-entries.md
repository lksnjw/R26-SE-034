---
policy_id: FIN-GL-2026-006
doc_type: policy
title: Manual journal entries and credit notes
applies_to_actions: [post_journal_entry, issue_credit_note]
risk_level: high
mandatory: false
version: "1.0"
effective_date: "2026-01-01"
is_current: true
source_document: general_ledger_manual.pdf
# Mixed backing, so `erp_backed` stays true for the document as a whole: journal
# entries are a real ERP document (`journal_entries`, docstatus 0 -> 1), credit
# notes are not — there is no credit note table anywhere in the migrations. §4
# therefore governs an action the ERP cannot currently perform. Kept deliberately.
requires_role: [finance_editor, finance_manager]
---

## 1. Scope

This policy governs manual journal entries posted to the general ledger and credit
notes issued against previously booked charges.

## 2. Journal entries

2.1 A manual journal entry must carry a narration that identifies the business event
being recorded. A narration consisting only of an adjustment reference, a person's
name, or the word "correction" is not sufficient.

2.2 A manual journal entry must be reviewed and released by a person other than the
person who prepared it. The preparer is the identity recorded against the entry when
it was created; submitting an entry under that same identity is not a review.

2.3 Manual entries to cash, bank, revenue, and suspense accounts require Finance
Manager approval regardless of value.

2.4 A suspense account balance must be cleared within 30 days of the entry being
raised. Entries that park a difference in suspense without an identified resolution
route must not be posted.

## 3. Period control

3.1 No entry may be posted to a closed accounting period. Where a correction relates
to a closed period, it is posted to the current open period with a narration
identifying the period it corrects.

3.2 Entries posted in the final three working days of a period to accounts subject to
management reporting are reported to the Finance Control Unit.

## 4. Credit notes

4.1 A credit note may be issued only against an identified invoice, and only for a
value not exceeding the outstanding value of that invoice.

4.2 A credit note must state the reason it was issued. A credit note issued to
extinguish a charge that is under dispute must record the dispute reference.

4.3 A credit note may not be issued by the person who approved the underlying
invoice.

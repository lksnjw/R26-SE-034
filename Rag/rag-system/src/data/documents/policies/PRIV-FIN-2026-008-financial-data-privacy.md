---
policy_id: PRIV-FIN-2026-008
doc_type: privacy_policy
title: Access to and disclosure of financial data
applies_to_actions: [view_ledger_entry, update_vendor_bank_details]
risk_level: high
mandatory: true
version: "1.0"
effective_date: "2026-01-01"
is_current: true
source_document: data_protection_policy.pdf
# No `requires_role` here on purpose. This policy is `mandatory`, so it is
# retrieved for every decision including payment release; a structured role
# requirement would then be enforced against actions it was never about. The
# roles that may access financial data are stated in clause 2.1 for the judge.
---

## 1. Scope and standing

1.1 This policy governs access to, and disclosure of, financial records including
ledger entries, vendor master data, bank account details, payment history, and
employee expense claims.

1.2 This policy applies to every response produced through an automated or
agent-assisted channel, including responses confirming an action that was itself
permitted. Authority to perform a transaction is not authority to disclose the data
involved in it.

## 2. Permitted access

2.1 Ledger and payment data may be accessed by holders of a Finance Editor or
Finance Manager role for a purpose connected with their
duties. The purpose must be recorded with the access.

2.2 An employee may view their own expense claims and reimbursements without further
authorization.

2.3 Access to the compensation, banking, or personal data of another individual
requires a documented business purpose. Curiosity, benchmarking, and comparison
against a colleague are not permitted purposes.

## 3. Disclosure through automated channels

3.1 A bank account number must never be returned in full through an automated
channel. Account numbers are masked to the last four digits in every response,
including responses confirming a successful bank detail change or payment.

3.2 An automated response must not repeat the personal data of a third party in free
text, even where the requester is entitled to view the underlying record.
Entitlement to view a record is not entitlement to have it recited into an unlogged
conversation.

3.3 Where a response would disclose more than the requester's purpose requires, the
response must be reduced to the fields necessary for that purpose.

3.4 Aggregate figures that identify a single individual or a single vendor are
treated as personal data of that party and are subject to this section.

## 4. Record keeping

4.1 Every access to financial data other than the requester's own records is logged
with the requester identity, the records accessed, the stated purpose, and the
timestamp.

4.2 Access logs are retained for six years and are reviewable by the Data Protection
Officer.

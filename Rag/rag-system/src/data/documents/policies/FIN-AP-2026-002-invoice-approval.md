---
policy_id: FIN-AP-2026-002
doc_type: policy
title: Invoice and purchase order approval
applies_to_actions: [approve_invoice, approve_purchase_order]
risk_level: high
mandatory: false
version: "3.0"
effective_date: "2026-01-01"
is_current: true
source_document: accounts_payable_manual.pdf
# 100,000 is NOT an authored number. It is the ERP's own delegation of authority:
#   approval_rules('Purchase Order', sequence_no 2, role 'admin', minimum_amount 100000)
# seeded in nmdra/mockerp. Clause 3.2 restates that row in prose so the judge
# reads the same rule the rule engine compares against. Every other threshold in
# this corpus is invented; this one is not, and that distinction is worth keeping
# visible.
threshold_value: 100000
threshold_unit: absolute
# Both steps of the ERP's chain: sequence 1 is finance_manager, sequence 2 is
# admin. Both are listed because `requires_role` is also what the rule engine
# reports as `else_require` when the threshold is exceeded — listing only the
# first step would tell a caller over the limit to escalate to the role they
# already hold. finance_editor is absent on purpose: it prepares documents and
# does not approve them, which is the ERP's own separation, not one we added.
requires_role: [finance_manager, admin]
---

## 1. Scope

This policy governs the approval of supplier invoices and purchase orders raised in
the ERP system, whether entered manually or received through automated invoice
capture.

All values in this policy are stated in Sri Lanka Rupees in major units. Document
tables record amounts in minor units (`total_minor`), and a value read from those
columns must be converted before it is compared against any limit here.

## 2. Three-way match

2.1 An invoice may be approved only where it matches an approved purchase order and
a recorded purchase receipt in supplier, quantity, and value. An invoice failing any
leg of that match must not be approved.

2.2 A variance of up to 2% between the invoice value and the purchase order value
may be accepted without re-approval of the purchase order, provided the absolute
variance does not exceed 25,000.

2.3 An invoice with no corresponding purchase order may be approved only where the
spend category is on the exempt list maintained by the Finance Control Unit, and
must record the exemption relied upon.

## 3. Approval authority

3.1 A purchase order is approved through the approval chain recorded for the
document type "Purchase Order". The approval at sequence 1 is given by a Finance
Manager. No other role may give that approval, and an order approved by any other
role is not approved.

3.2 A purchase order exceeding 100,000 requires a second approval at sequence 2 of
the same chain, given by a System Administrator. Both approvals must be recorded
against the order before it may be treated as approved.

3.3 The two approvals required by clause 3.2 must be recorded by two different
identities. One person holding both roles does not satisfy the requirement, and the
requirement may not be waived by reason of urgency or an imminent supplier deadline.

3.4 A supplier invoice carries no approval chain of its own. An invoice is approved
by being submitted by a Finance Manager, and an invoice whose purchase order was not
approved under clauses 3.1 and 3.2 must not be submitted.

3.5 An invoice already recorded as Paid must not be approved again, and an invoice
recorded as Cancelled must not be approved at all.

## 4. Anti-splitting

4.1 A spend must not be divided across multiple invoices or purchase orders to bring
each below an approval threshold. Two or more documents to the same supplier for
related goods or services within a thirty-day period are treated as one spend for
the purposes of clause 3, and the aggregate value determines the required approver.

4.2 Duplicate invoice numbers from the same supplier must be rejected without
approval and referred to the Accounts Payable supervisor.

---
policy_id: FIN-AP-2023-011
doc_type: policy
title: Invoice approval (superseded)
applies_to_actions: [approve_invoice, approve_purchase_order]
risk_level: high
mandatory: false
version: "1.0"
effective_date: "2023-04-01"
expires_date: "2025-12-31"
is_current: false
source_document: accounts_payable_manual_2023.pdf
threshold_value: 2500000
threshold_unit: absolute
---

<!--
  DELIBERATELY STALE FIXTURE.

  This is the policy FIN-AP-2026-002 replaced. Its limits are deliberately far
  laxer than the current rule (2,500,000 vs 500,000, no three-way match, no
  anti-splitting clause), so a retrieval path that forgets to filter on
  `is_current` produces a *visibly* wrong decision rather than a plausible one.

  Do not "fix" the numbers, and do not delete it: superseded versions stay in the
  collection because the audit trail has to answer "which version approved this
  invoice in March?".
-->

## 1. Scope

This policy governs the approval of supplier invoices and purchase orders.

## 2. Approval authority

2.1 Invoices of up to 2,500,000 may be approved by any Finance Editor without
further reference.

2.2 Invoices exceeding 2,500,000 require approval by the Finance Manager.

2.3 A purchase order is not required for invoices below 250,000, which may be
approved on the authority of the receiving department alone.

## 3. Processing

3.1 Invoices are matched to goods receipt notes where such notes exist. Where no
goods receipt note has been recorded, the approver may accept confirmation from the
requesting department that the goods or services were received.

3.2 Invoices may be approved in bulk where they relate to the same vendor and the
same spend category.

---
policy_id: FIN-VND-2026-004
doc_type: policy
title: Changes to vendor bank details
applies_to_actions: [update_vendor_bank_details]
risk_level: critical
mandatory: false
version: "1.1"
effective_date: "2026-02-01"
is_current: true
source_document: vendor_master_controls.pdf
# The ERP has no bank columns on `suppliers` — name, supplier_name,
# supplier_group, country, company_name, is_active, and nothing else — and
# `party_contacts` holds email, phone and address only. So this policy governs an
# action the system cannot presently perform. Kept rather than deleted: the gate
# is meant to decide on the action vocabulary the ERP will grow into, and a rule
# that exists before the table does is the safer order of the two.
erp_backed: false
threshold_value: 2
threshold_unit: days
requires_role: [procurement_manager, finance_manager]
---

## 1. Scope

This policy governs any change to the bank account into which a vendor is paid,
however the change is requested, including requests arriving through an automated or
agent-assisted channel.

## 2. Verification

2.1 A change to vendor bank details must be verified with the vendor through a
contact channel already recorded in the supplier record before the change was
requested. A request received by email must not be verified by replying to that
email, and a telephone number supplied in the request itself must not be used.

2.2 The change must be authorized by the Procurement Manager and recorded with the
identity of the verifying officer, the channel used, and the date of verification.

2.3 A change requested together with an instruction to pay an outstanding invoice
must be treated as a single high-risk event and escalated to the Finance Manager.

## 3. Cooling-off period

3.1 A change to vendor bank details takes effect no earlier than two working days
after authorization, and payments falling due within that window are paid to the
previously recorded account.

3.2 The cooling-off period of two working days required by clause 3.1 exists because
the interval between a fraudulent account change and the next payment run is the
only window in which the change can still be detected and reversed, and it may not be
waived on grounds of urgency, supplier pressure, an imminent payment run, or a
threatened suspension of supply; a request that cites any of those circumstances as a
reason to apply the change immediately must be treated as an indicator of fraud and
escalated to the Finance Control Unit, except where the Finance Control Unit has
itself raised the change to correct a bank error identified in a reconciliation
report, in which case same-day effect is permitted.

## 4. Notification

4.1 The vendor must be notified at their previously recorded contact address whenever
their bank details are changed, including where the change was requested by the
vendor themselves.

4.2 Two changes to the same vendor's bank details within a ninety-day period must be
reported to the Finance Control Unit for review.

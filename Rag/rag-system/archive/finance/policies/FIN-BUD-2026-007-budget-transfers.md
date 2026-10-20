---
policy_id: FIN-BUD-2026-007
doc_type: policy
title: Budget transfers and virement
applies_to_actions: [approve_budget_transfer]
risk_level: medium
mandatory: false
version: "1.0"
effective_date: "2026-01-01"
is_current: true
source_document: budget_control_manual.pdf
# No budgets, budget_lines or cost_centres table exists anywhere in the ERP
# migrations, so nothing here is checkable against a record today. Kept for the
# same reason as FIN-VND-2026-004: the rule is meant to exist before the table.
erp_backed: false
threshold_value: 10
threshold_unit: percent
requires_role: [finance_manager]
---

## 1. Scope

This policy governs the movement of approved budget between cost centres, budget
lines, and expense categories within a financial year.

## 2. Transfer limits

2.1 A transfer of up to 10% of the annual approved budget of the releasing cost
centre may be authorized by a Finance Manager.

2.2 A transfer exceeding 10% of the annual approved budget of the releasing cost
centre requires approval from a System Administrator.

2.3 The cumulative value of transfers out of a single cost centre within a financial
year is subject to the same limits. Successive transfers must not be used to move
more than 10% in aggregate under clause 2.1.

## 3. Prohibited transfers

3.1 Budget must not be transferred from a capital expenditure line to an operating
expenditure line, nor from a personnel cost line to any other line, without the
approval of a System Administrator.

3.2 Budget must not be transferred into a cost centre in order to accommodate a
spend that has already been incurred. A transfer that regularises a completed
overspend must be recorded as such and reported to the Finance Control Unit.

3.3 Budget must not be transferred between legal entities.

## 4. Recording

4.1 Every transfer must record the releasing and receiving cost centres, the value,
and the business reason for the movement.

4.2 An uncommitted balance in a cost centre does not by itself authorize a transfer
or a spend. Availability of funds is not approval.

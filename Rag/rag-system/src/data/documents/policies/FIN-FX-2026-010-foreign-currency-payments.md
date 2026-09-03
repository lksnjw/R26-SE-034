---
policy_id: FIN-FX-2026-010
doc_type: policy
title: Foreign currency and cross-border payments
applies_to_actions: [release_payment, approve_invoice, approve_purchase_order]
risk_level: critical
mandatory: false
version: "1.0"
effective_date: "2026-01-01"
is_current: true
source_document: treasury_controls_manual.pdf
# No threshold_value: the limits in this policy apply only when the payment is in
# foreign currency, and the deterministic engine cannot yet express a limit that
# is conditional on another fact — it would compare every domestic payment against
# an FX limit and report a breach that does not exist. These clauses are therefore
# judged on their text until the payload contract carries an `applies_when` field.
---

## 1. Scope

This policy governs commitments and payments denominated in any currency other
than Sri Lanka Rupees, and any payment to a beneficiary account held outside Sri
Lanka regardless of the currency used.

A cross-border payment cannot be recalled once it has left the correspondent
banking chain. The controls below therefore apply before release and not as a
subsequent review.

## 2. Currency of record

2.1 A purchase order or invoice must state the currency of the commitment. Where no
currency is stated, the document is treated as Sri Lanka Rupees and must not be paid
in any other currency.

2.2 A payment must be released in the currency stated on the approved invoice.
Substituting a different currency at the point of release — including paying a
rupee invoice in foreign currency at the vendor's request — requires the invoice to
be re-approved in the substituted currency.

2.3 The exchange rate applied must be the rate published for the value date. A rate
quoted by the vendor, or a rate carried over from an earlier transaction, must not
be used.

## 3. Additional authorization

3.1 Cross-border payments require the authorization of a Finance Manager in
addition to the approvals required by the payment release policy. This is an
additional approval and does not replace any approval otherwise required.

3.2 A cross-border payment to a beneficiary receiving payment from the organisation
for the first time requires confirmation of the beneficiary's banking details through
a channel independent of the one on which the payment instruction arrived.

3.3 Payments to jurisdictions subject to sanctions, or to beneficiaries appearing on
an applicable sanctions list, are prohibited and must not be released under any
authority granted elsewhere in this manual.

## 4. Regulatory obligations

4.1 Outward remittances must comply with the Foreign Exchange Act and the directions
issued under it by the Central Bank of Sri Lanka. Where a remittance requires
supporting documentation to be lodged with the authorised dealer, the payment must
not be released until that documentation exists.

4.2 The purpose of the remittance must be recorded against the payment in terms that
match the underlying commercial document. A generic purpose description is not
sufficient where a specific one is available.

4.3 Advance payments to overseas suppliers require evidence of the underlying
contract and, where goods are involved, evidence that the goods have been shipped or
that shipment is contractually due.

## 5. Rate movement between approval and release

5.1 Where the rupee value of a foreign currency payment has moved materially between
the date the invoice was approved and the date of release, the payment must be
re-approved at the higher value. An approval given at one rupee value does not
authorise a materially larger outflow at another.

5.2 Losses and gains arising from rate movement between commitment and settlement are
recorded against exchange difference and must not be absorbed into the original
expense account.

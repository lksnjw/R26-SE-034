# Response observations

These are direct comparisons with the submitted questions and benchmark
references, recorded by the coding assistant. They are not independent expert
ratings and are not counted as a factual-accuracy score.

| Case | Observed issue |
|---|---|
| ERP-001 | The question supplies period 006 2026 and company code 1000, but no amount or cost center. The generated instructions add cost center `500301` and amount `143,767 EUR` without marking them as examples. |
| ERP-002 | The reference requests vendor clearing with `F-44`. The response instead specifies `VF01` and `F-32`. An ERP reviewer should assess this procedure mismatch. |
| ERP-004 | The user requests fiscal period `007 2026`. The answer instead instructs `fiscal year 006, period 006` and adds account type `L`. This does not preserve the requested period/year. |
| ERP-005 | The reference describes reversing the document and preserving history. The response says to `delete the incorrect posting` and repost. A reviewer should assess whether these instructions preserve the required correction workflow. |
| ERP-011 | Despite ROUGE-L F1 of approximately `0.512`, the answer supplies quantity `12`, tax code `A0` and schedule line `000000001`, none supplied in the question. The values are presented as instructions rather than labeled examples. |

All five responses pass the WHAT/HOW/WHY format check. This demonstrates why
format compliance and lexical similarity alone cannot establish task correctness.

Read the full questions and responses in [results.csv](./results.csv); the table
contains selected observations, not a complete error classification. Independent
review remains pending in [human_review.csv](./human_review.csv).

ERP-038 is the in-scope formatting failure. It contains the words What, How and
Why, but starts with `SAP CLIENT COPY: What` and uses `How Use ...` and
`Why Client ...` without the required heading colons. Its failure is against the
stated strict format criterion, not proof that the response lacks all structure.

## Observed repeat variation

The separate smoke test produced `143,871 USD` in ERP-001, while the full run
produced `143,767 EUR`. Both used temperature 0 and seed 3407 with the same model
and question. This comparison establishes observed response variation, not its
cause or frequency. The smoke result is excluded from all full-run metrics.

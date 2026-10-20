# Fine-tuned ERP model evaluation

Model: `erp-finance-eval-20261020`

Dataset: `D:\Research\Implementation\R26-SE-034\Data\erp_eval_realistic_50.jsonl`. 50/50 samples evaluated.

| Measurement | Result |
|---|---:|
| In-scope / out-of-scope cases | 40 / 10 |
| In-scope WHAT/HOW/WHY format compliance | 97.50% |
| Out-of-scope refusal heuristic | 100.00% |
| In-scope false-refusal heuristic | 0.00% |
| In-scope mean ROUGE-L F1 | 0.3219098768827757 |
| ROUGE-L ≥ 0.35 agreement rate | 27.50% |
| ROUGE-L ≥ 0.5 agreement rate | 2.50% |
| Request errors / token-limit truncations | 0 / 0 |

ROUGE measures wording overlap with reference answers. Its threshold rates are not factual or policy-validation accuracy.

## Interpretation

- The GGUF is the user-identified export of `llna 3.1 with drive.ipynb`. Evaluation preserves system/user roles using the imported model's chat template.
- The benchmark has 50 reference answers used by the notebook; it is not an independently authored blind final-test dataset.
- Exact overlap is checked against available local datasets. The notebook's original `erp_whw_1000_balanced.jsonl` training artifact has not been verified.
- Refusal detection is a text heuristic, not semantic correctness. In-scope non-refusals can still be wrong; refusals can still contain inappropriate content.
- Human review of correctness, completeness and invented company rules remains pending in human_review.csv.
- No matched untuned Llama 3.1 8B baseline was run, so improvements caused by fine-tuning are not established.
- Errors remain in denominators and score zero lexical overlap. Truncated outputs are retained and flagged.
- Latency includes local runtime work and the first request's model load. This is separate from the RAG policy-gate evaluation.

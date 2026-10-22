# Evaluating the registration RAG example

This guide describes the reusable evaluator. Completed research reports and the
HTML renderer have been moved to the external archive listed in the workspace README.

Run from `Rag/rag-system` using the existing `.env`. No ERP users are created.
The runner uses local gate code against real configured Qdrant, embeddings and
judge services. It does not test the Azure HTTP deployment or inbound API keys.
Only the configured `policy_docs` collection and EMP-REG-001 through EMP-REG-011
are evaluated. Adding documents to another collection does not expand this scope.

```powershell
# Inspect/export synthetic cases without network calls.
.\.venv\Scripts\python.exe -m scripts.eval_registration --prepare-only

# Live benchmark, two separate passes, at most two concurrent submissions.
.\.venv\Scripts\python.exe -m scripts.eval_registration --repeat 2 --concurrency 2

# Offline test suite, including evaluation accounting checks.
.\.venv\Scripts\python.exe -m unittest discover -s tests
```

The live run invokes paid/rate-limited services according to your current
provider configuration. It writes actual audits to an isolated file inside the
run directory, leaving the production audit collection and policies untouched.
`--limit 5` is useful for a smoke check. Results from a limited run are not a full
benchmark. Exit 0 means all cases and injected faults passed; 1 means observed
failures (reports are still saved); 2 means live corpus/dependency preflight failed.

## Dataset and labels

`scripts/registration_benchmark.py` defines explicit policy-derived expectations
for more than 100 cases, without asking the system under test to supply answers.
It covers Unicode names, normalization, mandatory fields, authorization,
duplicates, dates, foreign locations/phones, ambiguous inputs, combined violations,
and instructions embedded in employee data. It intentionally does not pad this
set to 300 using near-identical random rows.

These are synthetic development cases, **not independently reviewed gold labels**.
Requester identities and duplicate lookup results are fixtures, not actual ERP
checks. Two reviewers should examine labels and expected explanations against
the source policies, resolve disagreements, and build a separate held-out set.
Do not tune the implementation against final-test results and continue calling
the same cases held out. Split by scenario/template family, not random near-duplicate
rows. Results support this synthetic policy prototype, not legal compliance or
all real Sri Lankan employee records.

For independently labelled cases, pass `--dataset path/to/cases.jsonl`. Use the
schema exported to `dataset.jsonl`: `case_id`, `category`, `request`,
`expected_verdict`, `expected_failed_policies`, `expected_failed_fields`, optional
`expected_normalized` (partial field/value map), and `label_status`.
Do not put real credentials or employee PII in the dataset or output artifacts.

The validation date is frozen for every case in a run and stored in the manifest.
To replay a saved dataset, also specify its original date:

```powershell
.\.venv\Scripts\python.exe -m scripts.eval_registration --dataset var/evaluations/RUN/dataset.jsonl --as-of 2026-10-19 --repeat 2
```

Built-in expectations assume no configured email-domain restriction and no
UTC-offset mapping. The runner refuses those configurations unless a custom
dataset is supplied. Change expectations only when authoritative policy changes,
not to improve a measured score.

## Outputs

Each run creates a new `var/evaluations/<timestamp>/` directory, never overwriting
an existing one. `var` is git-ignored; copy reviewed research artifacts to your
research archive deliberately.

| File | Purpose |
|---|---|
| `REPORT.md` | Readable results, confusion matrix, failures and limitations |
| `summary.json` | Accuracy, macro F1, per-class and category scores, latency, confidence intervals |
| `manifest.json` | Frozen date, model names, source hashes, dataset hash, run settings |
| `dataset.jsonl` | Exact cases and expected outcomes used |
| `inventory.json` | Counts and policy IDs actually found in the configured collection |
| `policy_snapshot.json` | Authoritative section text and metadata used for the run |
| `results.jsonl` | Incremental complete responses, findings, section references and component timings |
| `results.csv` | Spreadsheet-friendly comparison of expected and actual results |
| `baseline.jsonl` | Deterministic-only comparator on the same cases |
| `retrieval.jsonl` | Separate semantic ranking and full-context measurements |
| `faults.json` | Three explicitly injected outages; separate from live accuracy |
| `audit.jsonl` | Real local audit writes from the evaluation |
| `explanation_review.csv` | Empty reviewer scoring columns plus actual explanations |

## Metrics and interpretation

Accuracy includes runtime errors as incorrect results. Macro F1 averages all
three verdict classes, using zero for undefined per-class precision/recall.
Category scores may lack classes, so compare per-category accuracy and supports
rather than interpreting their macro F1 as a balanced three-class experiment.

Unsafe-ALLOW rate = predicted ALLOW among cases expected BLOCK or ESCALATE,
divided by the number of cases expected BLOCK or ESCALATE. Report the counts.
Full-contract pass additionally requires exact failed policy/field sets,
specified normalization outputs, persisted audit and consistent `can_create`.
Policy and field precision/recall are micro-averaged set comparisons. Error rows
remain failures even if both expected and actual failed-policy sets are empty.

Repeated calls measure verdict stability. They are not independent cases.
Wilson 95% intervals use first-pass observations only; the synthetic template
distribution still limits inference to real production traffic. A zero observed
unsafe-ALLOW rate does not establish zero risk.

The current retriever first scrolls all metadata-matching authoritative sections,
then merges semantic results. End-to-end retrieval coverage cannot demonstrate
semantic ranking quality. Eleven explicit field probes capture raw ranked results
from the actual retriever separately, with section-level relevance labels and
precision/recall at 5 and configured top-k. Precision divides by the number
actually returned up to k. Governance/global sections are relevant to every
probe; the labels should also undergo independent review. This small set is a
diagnostic, not a comprehensive retrieval benchmark. It uses field-specific
queries, whereas full-form validation retrieves the complete corpus.

The deterministic baseline deliberately omits narrative location/date review,
retrieval and auditing. Its simulated ALLOW is not safe for ERP execution.
Compare per-category results to establish where the LLM adds useful checks.
Three separate fault cases inject retrieval, judge or audit unavailability with
fixture dependencies. They measure fail-closed behavior, not hosted uptime.
Run the existing unit/integration suite for stale policies, missing sections,
authentication and malformed model-output checks as well.

Review explanations for policy support, identification of the input problem,
actionability and invented rules. Merely citing an existing policy is not proof
of faithfulness. No automatic human-review or faithfulness scores are fabricated.
API transport/authentication, Azure cold starts, real ERP duplicate checks,
production audit durability, additional policy flows, and model monetary cost
are outside these results. Provider token usage is not currently instrumented.

# Fine-tuned ERP model evaluation

The downloaded GGUF was identified by its owner as the export from
[`llna 3.1 with drive.ipynb`](./llna%203.1%20with%20drive.ipynb), using the older
dataset. It is evaluated locally through Ollama, independently of the RAG
policy gate.

The benchmark is [`erp_eval_realistic_50.jsonl`](../Data/erp_eval_realistic_50.jsonl):
40 ERP questions and 10 questions whose references require refusal. The notebook
already uses this benchmark, so it should not be described as a newly blinded
final test.

## Recorded run

The complete run is stored in
[`evaluations/finance-model-20261020/`](./evaluations/finance-model-20261020/).
During execution the reports are checkpoints; check `status` and `evaluated`
in `summary.json` before using them as final results.

- [`REPORT.md`](./evaluations/finance-model-20261020/REPORT.md): readable results and interpretation.
- [`summary.json`](./evaluations/finance-model-20261020/summary.json): aggregate metrics.
- [`results.csv`](./evaluations/finance-model-20261020/results.csv): questions, references, generated answers and per-case scores.
- [`raw_responses.jsonl`](./evaluations/finance-model-20261020/raw_responses.jsonl): recorded Ollama responses and runtime timings.
- [`manifest.json`](./evaluations/finance-model-20261020/manifest.json): model file hash, dataset/notebook/evaluator hashes, runtime version and generation settings.
- [`overlap_audit.json`](./evaluations/finance-model-20261020/overlap_audit.json): exact normalized prompt overlaps with available datasets.
- [`human_review.csv`](./evaluations/finance-model-20261020/human_review.csv): blank worksheet for independent ERP review.
- [`QUALITATIVE_OBSERVATIONS.md`](./evaluations/finance-model-20261020/QUALITATIVE_OBSERVATIONS.md): selected issues visible in the generated answers, without an expert-accuracy claim.
- [`hardware.json`](./evaluations/finance-model-20261020/hardware.json): machine and runtime placement observed during evaluation.

The one-case smoke test in `evaluations/smoke-20261020/` is a runtime check,
not an additional benchmark sample. Do not combine it with the 50-case run.

## Measurements

| Measurement | Meaning |
|---|---|
| WHAT/HOW/WHY compliance | Three ordered, nonempty sections with `WHAT:`, `HOW:`, `WHY:` headings at line starts; Markdown emphasis and heading prefixes accepted |
| Out-of-scope refusal proxy | A recognizable refusal phrase on a refusal-reference question |
| In-scope false-refusal proxy | A recognizable refusal phrase on an ERP question |
| ROUGE-1/2/L F1 | Lexical agreement with the supplied reference, with stemming |
| ROUGE-L threshold agreement | Fractions meeting the existing 0.35 and 0.50 similarity thresholds |
| Errors and truncation | Failed requests and responses reaching the generation token limit |
| Latency | End-to-end local request time, including initial model loading |

ROUGE thresholds are **not correctness accuracy**. The refusal checks are
heuristics; they do not establish that an answer is appropriate or complete.
Errors remain in metric denominators and contribute zero ROUGE. Truncated
responses remain in the evidence.

The overlap audit found no exact normalized prompt matches with the available
local datasets. The original notebook training file,
`erp_whw_1000_balanced.jsonl`, is absent, so training exclusion cannot be fully
verified. The audit does not detect paraphrases.

No matched untuned Llama 3.1 8B baseline is included. These measurements describe
the downloaded model; they do not establish improvement caused by fine-tuning.

## Reproduce on this computer

The existing root virtual environment provides `requests` and `rouge-score`.
Their versions are recorded in the run manifest. Ollama must be running.
For a fresh Python environment, install
[`requirements-evaluation.txt`](./requirements-evaluation.txt).

```powershell
ollama create erp-finance-eval-20261020 -f Model/Modelfile.finance-evaluation

.\.venv\Scripts\python.exe Model/evaluate_model.py `
  --model erp-finance-eval-20261020 `
  --data Data/erp_eval_realistic_50.jsonl `
  --samples 50 `
  --context 2048 `
  --max-tokens 384 `
  --gguf D:\Research\Model\Meta-Llama-3.1-8B-Instruct.Q4_K_M.gguf

.\.venv\Scripts\python.exe -m unittest discover -s Model/tests -v
```

Omitting `--output-dir` creates a timestamped directory. Existing result
directories are never overwritten. Adjust the `FROM` path in the Modelfile
when running on another computer.

The evaluator uses the imported Llama chat template and the benchmark's separate
system/user messages. It sets temperature 0 and seed 3407, runs one request at a
time, and saves evidence after each response. Runtime/hardware differences can
still affect reproducibility.
The smoke test and full run produced different responses for ERP-001 under the
same recorded seed and generation options. A fixed seed and temperature zero did
not guarantee identical responses in these observed requests. Only the full run
contributes to the reported benchmark metrics; repeat-run stability has not been
systematically measured.

## Independent review

Review `human_review.csv` against authoritative ERP documentation and the actual
company configuration. Suggested codes:

- `erp_correctness`: 0 incorrect, 1 partly correct, 2 correct.
- `completeness`: 0 missing essential steps, 1 partly complete, 2 sufficient.
- `invented_company_rule`: yes / no / uncertain.
- `appropriate_refusal`: yes / no / not applicable.

Record unsupported amounts, account identifiers and other invented input values
in `notes`. Leave unavailable judgments blank; do not infer expert correctness
from the automated metrics. Use independent reviewers and report agreement if
the research claims depend on these judgments.

The previous evaluator is preserved in
[`archive/evaluate_model_legacy.py`](./archive/evaluate_model_legacy.py).

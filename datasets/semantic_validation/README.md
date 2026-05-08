# Semantic Validation Gate Synthetic Dataset

Researcher: Sanjeewa P.D.L.B - IT22629708

Project: Low-Code Workflow Automation Engine / Agentic Orchestrator

This folder generates a 5,000-example synthetic ERP workflow dataset for testing the Go Semantic Validation Gate.

## Files

- `generate_dataset.py` - deterministic generator for 100 JSONL batches and merged files.
- `validate_dataset.py` - schema, count, and flag validator.
- `batch_001.jsonl` to `batch_100.jsonl` - 50 examples per batch.
- `dataset_full_5000.jsonl` - merged JSONL dataset.
- `dataset_full_5000.json` - standard JSON array version.
- `dataset_full_5000.csv` - CSV version of the same dataset.

## Distribution

| Category | Count |
|---|---:|
| perfect | 3000 |
| missing_parameters | 500 |
| unauthorized_action | 500 |
| hallucinated_action | 500 |
| rbac_violation | 500 |

## Usage

```powershell
python generate_dataset.py
python validate_dataset.py dataset_full_5000.jsonl
```

The dataset is designed for:

- Fine-tuning a local LLM to emit structured YAML workflows.
- Measuring Semantic Validation Gate precision, recall, and F1 score.
- Testing self-healing hints for broken YAML workflow repair.

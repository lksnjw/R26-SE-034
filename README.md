# Fine-tune-Llama

Simple project for fine-tuning a Llama 3.1 model with LoRA on ERP-focused instruction data and evaluating the model with format and ROUGE-L checks.

## Project structure

- **`fine_tune_cpu.py`** — LoRA fine-tuning script (CPU setup).
- **`evaluate_model.py`** — evaluates model outputs and writes CSV metrics.
- **`test_raw.py`, `test_new_model.py`** — quick prompt-based smoke tests through Ollama APIs.
- **`ft_data/`** — training and evaluation datasets in JSONL format.
- **`Modelfile`** — Ollama model configuration and strict ERP system prompt.

## Requirements

- Python 3.10+
- Install dependencies:

```bash
pip install -r requirements.txt
# evaluation extras
pip install pandas rouge-score
```

## Fine-tune

Update values inside `fine_tune_cpu.py` if needed (model name, dataset path, and training parameters), then run:

```bash
python fine_tune_cpu.py
```

The script saves LoRA weights and tokenizer to `local_cpu_lora_model/`.

## Evaluate

Run evaluation against an Ollama-served model:

```bash
python evaluate_model.py --model my-finance-model:latest --samples 50 --data ft_data/erp_whw_1000_balanced.jsonl --output evaluation_results.csv
```

## Quick tests

```bash
python test_raw.py
python test_new_model.py
```

These scripts send sample prompts to the default local Ollama endpoint (`http://localhost:11434`), so make sure Ollama is running there before testing.

"""Reproducible local GGUF/Ollama evaluation of the fine-tuned ERP model.

Run from the repository root:
  .venv/Scripts/python.exe Model/evaluate_model.py --model erp-finance-eval-20261020 --samples 50

ROUGE is lexical agreement, not factual correctness. No RAG/ERP actions are run.
"""
import argparse
import csv
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.metadata
import json
from pathlib import Path
import re
import statistics
import time

import requests
from rouge_score import rouge_scorer

ROOT = Path(__file__).resolve().parents[1]
TZ = timezone(timedelta(hours=5, minutes=30))
REFUSAL_PATTERNS = [
    r"\bACTION\s+BLOCKED\b", r"\bOUT[_ -]OF[_ -]SCOPE\b",
    r"\b(?:cannot|can't|unable to)\s+(?:answer|assist|help)\b",
    r"\b(?:not related to|unrelated to|outside (?:the |my )?scope of|not (?:an? )?)\s*(?:ERP|enterprise resource planning)\b",
    r"\bonly\s+(?:answer|assist|help|provide)[^.\n]{0,100}\b(?:ERP|enterprise resource planning)\b",
]


def normalize(text):
    return " ".join(text.casefold().split())


def expected_refusal(reference):
    return bool(re.search(r"\b(?:ACTION\s+BLOCKED|OUT[_ -]OF[_ -]SCOPE)\b", reference, re.I))


def refusal_proxy(text):
    return any(re.search(pattern, text, re.I) for pattern in REFUSAL_PATTERNS)


def whw_format(text):
    """Require ordered, nonempty WHAT/HOW/WHY sections; accept Markdown emphasis."""
    plain = text.replace("**", "").replace("__", "")
    matches = list(re.finditer(r"(?:^|\n)\s*(?:#{1,6}\s*)?(WHAT|HOW|WHY)\s*:\s*", plain, re.I))
    if [m.group(1).upper() for m in matches] != ["WHAT", "HOW", "WHY"]:
        return False
    ends = [m.start() for m in matches[1:]] + [len(plain)]
    return all(plain[m.end():end].strip() for m, end in zip(matches, ends))


def load_dataset(path):
    rows = [json.loads(line) for line in Path(path).read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    for i, row in enumerate(rows, 1):
        if not all(isinstance(row.get(key), str) and row[key].strip() for key in ("system", "user", "assistant")):
            raise ValueError(f"Row {i} needs nonempty system/user/assistant strings")
    if not rows:
        raise ValueError("Empty evaluation dataset")
    return rows


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def dump(path, obj):
    Path(path).write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")


def append(path, obj):
    with Path(path).open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(obj, ensure_ascii=False) + "\n")


def percentile(values, q):
    if not values:
        return None
    data = sorted(values)
    rank = (len(data) - 1) * q
    lower = int(rank)
    return data[lower] + (data[min(lower + 1, len(data) - 1)] - data[lower]) * (rank - lower)


def overlap_audit(dataset, directory, evaluation_path):
    prompts = {normalize(row["user"]) for row in dataset}
    files = []
    for path in sorted(Path(directory).glob("*.jsonl")):
        if path.resolve() == evaluation_path.resolve():
            continue
        other = [json.loads(line) for line in path.read_text(encoding="utf-8-sig").splitlines() if line.strip()]
        other_prompts = {normalize(row.get("user", "")) for row in other}
        files.append(dict(file=path.name, sha256=digest(path), rows=len(other),
                          exact_normalized_prompt_overlap=len(prompts & other_prompts)))
    return dict(unique_evaluation_prompts=len(prompts), duplicate_evaluation_rows=len(dataset)-len(prompts),
        scanned_files=files, original_notebook_training_filename="erp_whw_1000_balanced.jsonl",
        original_training_file_present=(Path(directory) / "erp_whw_1000_balanced.jsonl").exists(),
        limitation="Exact prompt overlap only. The original training file is not verified; zero overlap with available files does not prove an untouched test set.")


def summarize(results, expected_count):
    n = len(results)
    in_scope = [r for r in results if not r["expected_refusal"]]
    outside = [r for r in results if r["expected_refusal"]]
    successful = [r for r in results if r["status"] == "ok"]
    ratio = lambda numerator, denominator: numerator / denominator if denominator else None
    matrix = {"IN_SCOPE": {"ANSWER": 0, "REFUSAL": 0, "ERROR": 0}, "OUT_OF_SCOPE": {"ANSWER": 0, "REFUSAL": 0, "ERROR": 0}}
    for r in results:
        matrix["OUT_OF_SCOPE" if r["expected_refusal"] else "IN_SCOPE"]["ERROR" if r["status"] != "ok" else "REFUSAL" if r["refusal_proxy"] else "ANSWER"] += 1
    return dict(status="complete" if n == expected_count else "partial", evaluated=n, expected_count=expected_count,
        in_scope_count=len(in_scope), out_of_scope_count=len(outside), errors=n-len(successful),
        truncated=sum(r["done_reason"] == "length" for r in results),
        in_scope_whw_format_rate=ratio(sum(r["status"] == "ok" and r["whw_format"] for r in in_scope), len(in_scope)),
        out_of_scope_refusal_proxy_rate=ratio(sum(r["status"] == "ok" and r["refusal_proxy"] for r in outside),len(outside)),
        in_scope_false_refusal_proxy_rate=ratio(sum(r["status"] == "ok" and r["refusal_proxy"] for r in in_scope),len(in_scope)),
        response_scope_proxy_matrix=matrix,
        in_scope_rouge={key: statistics.mean(r[key] for r in in_scope) if in_scope else None for key in ("rouge1", "rouge2", "rougeL")},
        in_scope_rougeL_standard_agreement_rate=ratio(sum(r["status"] == "ok" and r["standard_agreement"] for r in in_scope),len(in_scope)),
        in_scope_rougeL_strict_agreement_rate=ratio(sum(r["status"] == "ok" and r["strict_agreement"] for r in in_scope),len(in_scope)),
        latency_seconds={"p50": percentile([r["latency_seconds"] for r in results], .5), "p95": percentile([r["latency_seconds"] for r in results], .95)},
        median_generation_tokens_per_second=statistics.median([r["tokens_per_second"] for r in successful if r["tokens_per_second"] is not None]) if any(r["tokens_per_second"] is not None for r in successful) else None,
        factual_correctness="NOT_MEASURED_REQUIRES_HUMAN_REVIEW", fine_tuning_improvement="NOT_MEASURED_MATCHED_BASE_MODEL_NOT_RUN")


def write_reports(output, results, manifest):
    summary = summarize(results, manifest["selected_count"])
    dump(output / "summary.json", summary)
    columns = ["case_id", "expected_refusal", "status", "whw_format", "refusal_proxy", "rouge1", "rouge2", "rougeL", "latency_seconds", "done_reason", "tokens_per_second", "user", "reference", "generated"]
    with (output / "results.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=columns, extrasaction="ignore")
        writer.writeheader(); writer.writerows(results)
    with (output / "human_review.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        columns = ["case_id", "user", "reference", "generated", "reviewer", "erp_correctness", "completeness", "invented_company_rule", "appropriate_refusal", "notes"]
        writer = csv.DictWriter(stream, fieldnames=columns, extrasaction="ignore")
        writer.writeheader(); writer.writerows(results)
    percent = lambda v: f"{v:.2%}" if v is not None else "Not applicable"
    lines = ["# Fine-tuned ERP model evaluation", "", f"Model: `{manifest['model']}`", "",
        f"Dataset: `{manifest['dataset_file']}`. {summary['evaluated']}/{summary['expected_count']} samples evaluated.", "",
        "| Measurement | Result |", "|---|---:|",
        f"| In-scope / out-of-scope cases | {summary['in_scope_count']} / {summary['out_of_scope_count']} |",
        f"| In-scope WHAT/HOW/WHY format compliance | {percent(summary['in_scope_whw_format_rate'])} |",
        f"| Out-of-scope refusal heuristic | {percent(summary['out_of_scope_refusal_proxy_rate'])} |",
        f"| In-scope false-refusal heuristic | {percent(summary['in_scope_false_refusal_proxy_rate'])} |",
        f"| In-scope mean ROUGE-L F1 | {summary['in_scope_rouge']['rougeL']} |",
        f"| ROUGE-L ≥ {manifest['standard_threshold']} agreement rate | {percent(summary['in_scope_rougeL_standard_agreement_rate'])} |",
        f"| ROUGE-L ≥ {manifest['strict_threshold']} agreement rate | {percent(summary['in_scope_rougeL_strict_agreement_rate'])} |",
        f"| Request errors / token-limit truncations | {summary['errors']} / {summary['truncated']} |", "",
        "ROUGE measures wording overlap with reference answers. Its threshold rates are not factual or policy-validation accuracy.", "",
        "## Interpretation", "",
        "- The GGUF is the user-identified export of `llna 3.1 with drive.ipynb`. Evaluation preserves system/user roles using the imported model's chat template.",
        "- The benchmark has 50 reference answers used by the notebook; it is not an independently authored blind final-test dataset.",
        "- Exact overlap is checked against available local datasets. The notebook's original `erp_whw_1000_balanced.jsonl` training artifact has not been verified.",
        "- Refusal detection is a text heuristic, not semantic correctness. In-scope non-refusals can still be wrong; refusals can still contain inappropriate content.",
        "- Human review of correctness, completeness and invented company rules remains pending in human_review.csv.",
        "- No matched untuned Llama 3.1 8B baseline was run, so improvements caused by fine-tuning are not established.",
        "- Errors remain in denominators and score zero lexical overlap. Truncated outputs are retained and flagged.",
        "- Latency includes local runtime work and the first request's model load. This is separate from the RAG policy-gate evaluation.", ""]
    (output / "REPORT.md").write_text("\n".join(lines), encoding="utf-8")
    return summary


def run(args):
    all_rows = load_dataset(args.data)
    selected = all_rows[:args.samples] if args.samples else all_rows
    output = args.output_dir or ROOT / "Model" / "evaluations" / datetime.now(TZ).strftime("%Y%m%dT%H%M%S")
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    for index, row in enumerate(selected, 1):
        append(output / "dataset.jsonl", {"case_id": f"ERP-{index:03d}", **row})
    manifest = dict(started_at=datetime.now(TZ).isoformat(), model=args.model, dataset_file=str(args.data),
        dataset_sha256=digest(args.data), selected_count=len(selected), samples_requested=args.samples,
        standard_threshold=args.standard_threshold, strict_threshold=args.strict_threshold,
        generation_options=dict(temperature=0, seed=3407, num_ctx=args.context, num_predict=args.max_tokens),
        api="/api/chat", timeout_seconds=args.timeout, source_notebook="Model/llna 3.1 with drive.ipynb",
        source_notebook_sha256=digest(ROOT / "Model" / "llna 3.1 with drive.ipynb"),
        evaluator_sha256=digest(__file__), provenance="User confirmed GGUF export from the older notebook",
        dependencies={name: importlib.metadata.version(name) for name in ("requests", "rouge-score")})
    if args.gguf:
        manifest["gguf"] = dict(path=str(args.gguf), size_bytes=args.gguf.stat().st_size, sha256=digest(args.gguf))
    dump(output / "manifest.json", manifest)
    dump(output / "overlap_audit.json", overlap_audit(selected, ROOT / "Data", args.data))
    session = requests.Session()
    session.trust_env = False
    try:
        info = session.post(args.url.rstrip('/') + '/api/show', json={"model": args.model}, timeout=(10, 60))
        info.raise_for_status()
        show = info.json()
        dump(output / "model_info.json", {k: show.get(k) for k in ("details", "model_info", "parameters", "template", "capabilities")})
        version = session.get(args.url.rstrip('/') + '/api/version', timeout=10)
        version.raise_for_status()
        manifest["ollama_version"] = version.json().get("version")
        dump(output / "manifest.json", manifest)
    except requests.RequestException as exc:
        dump(output / "summary.json", dict(status="preflight_failed", error_type=type(exc).__name__))
        print(f"Model preflight failed: {type(exc).__name__}. Results directory: {output}", flush=True)
        return 2
    scorer = rouge_scorer.RougeScorer(["rouge1", "rouge2", "rougeL"], use_stemmer=True)
    results = []
    print(f"Model: {args.model} | {len(selected)} cases | output: {output.resolve()}", flush=True)
    for index, item in enumerate(selected, 1):
        started = time.perf_counter()
        result = dict(case_id=f"ERP-{index:03d}", user=item["user"], reference=item["assistant"],
            expected_refusal=expected_refusal(item["assistant"]), status="ok", error_type=None,
            generated="", done_reason=None, prompt_eval_count=None, eval_count=None, tokens_per_second=None,
            load_duration_seconds=None)
        try:
            response = session.post(args.url.rstrip('/') + '/api/chat', json={
                "model": args.model, "stream": False,
                "messages": [{"role": "system", "content": item["system"]}, {"role": "user", "content": item["user"]}],
                "options": manifest["generation_options"], "keep_alive": "30m",
            }, timeout=(10, args.timeout))
            response.raise_for_status()
            body = response.json()
            append(output / "raw_responses.jsonl", {"case_id": result["case_id"], "response": body})
            result["generated"] = body.get("message", {}).get("content", "").strip()
            if not result["generated"]:
                raise ValueError("Empty generated response")
            for key in ("done_reason", "prompt_eval_count", "eval_count"):
                result[key] = body.get(key)
            result["load_duration_seconds"] = body.get("load_duration", 0) / 1e9
            if body.get("eval_duration", 0) > 0:
                result["tokens_per_second"] = body.get("eval_count", 0) / (body["eval_duration"] / 1e9)
        except (requests.RequestException, ValueError) as exc:
            result.update(status="error", error_type=type(exc).__name__)
            if isinstance(exc, requests.HTTPError):
                result["http_status"] = exc.response.status_code
                try:
                    result["server_error"] = exc.response.json().get("error", "")
                except ValueError:
                    pass
        result["latency_seconds"] = time.perf_counter() - started
        result["whw_format"] = whw_format(result["generated"])
        result["refusal_proxy"] = refusal_proxy(result["generated"])
        scores = scorer.score(result["reference"], result["generated"] if result["status"] == "ok" else "")
        result.update({key: scores[key].fmeasure for key in ("rouge1", "rouge2", "rougeL")})
        result["standard_agreement"] = result["rougeL"] >= args.standard_threshold
        result["strict_agreement"] = result["rougeL"] >= args.strict_threshold
        results.append(result)
        append(output / "results.jsonl", result)
        write_reports(output, results, manifest)
        print(f"{index}/{len(selected)} {result['case_id']} {result['status']} WHW={result['whw_format']} refusal={result['refusal_proxy']} ROUGE-L={result['rougeL']:.3f} {result['latency_seconds']:.1f}s", flush=True)
        # Avoid repeatedly invoking a runtime that cannot load this model.
        if len(results) >= 3 and all(r["status"] == "error" for r in results[-3:]):
            print("Stopped after three consecutive request errors; partial results retained.", flush=True)
            break
    manifest["finished_at"] = datetime.now(TZ).isoformat()
    dump(output / "manifest.json", manifest)
    summary = write_reports(output, results, manifest)
    print(json.dumps(summary, indent=2), flush=True)
    print(f"Report: {output / 'REPORT.md'}", flush=True)
    return 1 if summary["errors"] or summary["status"] != "complete" else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="erp-finance-eval-20261020")
    parser.add_argument("--data", type=Path, default=ROOT / "Data" / "erp_eval_realistic_50.jsonl")
    parser.add_argument("--samples", type=int, default=50, help="First N records; 0 means the entire specified dataset")
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--gguf", type=Path, help="Optional original GGUF to hash for provenance")
    parser.add_argument("--url", default="http://127.0.0.1:11434")
    parser.add_argument("--context", type=int, default=2048)
    parser.add_argument("--max-tokens", type=int, default=384)
    parser.add_argument("--timeout", type=float, default=600)
    parser.add_argument("--standard-threshold", type=float, default=.35)
    parser.add_argument("--strict-threshold", type=float, default=.50)
    args = parser.parse_args()
    if args.samples < 0 or args.context < 1 or args.max_tokens < 1 or args.timeout <= 0:
        parser.error("Invalid sample/context/token/timeout limits")
    if not 0 <= args.standard_threshold <= args.strict_threshold <= 1:
        parser.error("Require 0 <= standard threshold <= strict threshold <= 1")
    raise SystemExit(run(args))


if __name__ == "__main__":
    main()

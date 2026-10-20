"""Export saved evaluation evidence as a standalone, offline HTML report.

python -m scripts.render_evaluation var/evaluations/research-20261019
No live services, external assets, credentials, or production writes are used.
"""
import argparse
from html import escape
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL_RUN = ROOT.parents[1] / "Model" / "evaluations" / "finance-model-20261020"


def read_jsonl(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def model_section(run_dir: Path):
    summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
    manifest = json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))
    results = read_jsonl(run_dir / "results.jsonl")
    if summary.get("status") != "complete" or len(results) != summary["evaluated"] or len(results) != summary["expected_count"]:
        raise ValueError("A complete model evaluation with matching counts is required")
    if len({r["case_id"] for r in results}) != len(results):
        raise ValueError("Duplicate model evaluation case IDs")
    e = lambda value: escape(str(value), quote=True)
    pct = lambda value: f"{value:.2%}" if value is not None else "Not applicable"
    score = lambda value: f"{value:.3f}" if value is not None else "Not applicable"
    metric = lambda label, value, sub: (
        f'<div class="metric"><div class="label">{e(label)}</div>'
        f'<div class="value">{e(value)}</div><div class="sub">{e(sub)}</div></div>')
    inside = [r for r in results if not r["expected_refusal"]]
    outside = [r for r in results if r["expected_refusal"]]
    formatted = sum(r["status"] == "ok" and r["whw_format"] for r in inside)
    refused = sum(r["status"] == "ok" and r["refusal_proxy"] for r in outside)
    cards = (
        metric("Evaluated questions", len(results), f"{len(inside)} ERP / {len(outside)} out of scope")
        + metric("Strict format compliance", pct(summary["in_scope_whw_format_rate"]), f"{formatted} / {len(inside)} ERP answers use WHAT: / HOW: / WHY:")
        + metric("Out-of-scope refusal", pct(summary["out_of_scope_refusal_proxy_rate"]), f"{refused} / {len(outside)} detected by the text heuristic")
        + metric("Mean ROUGE-L F1", score(summary["in_scope_rouge"]["rougeL"]), "Wording similarity across ERP answers"))
    measurements = [
        ("Mean ROUGE-1 / ROUGE-2 F1", f'{score(summary["in_scope_rouge"]["rouge1"])} / {score(summary["in_scope_rouge"]["rouge2"])}'),
        (f'ROUGE-L ≥ {manifest["standard_threshold"]} agreement', pct(summary["in_scope_rougeL_standard_agreement_rate"])),
        (f'ROUGE-L ≥ {manifest["strict_threshold"]} agreement', pct(summary["in_scope_rougeL_strict_agreement_rate"])),
        ("In-scope false-refusal heuristic", pct(summary["in_scope_false_refusal_proxy_rate"])),
        ("Request errors / truncated responses", f'{summary["errors"]} / {summary["truncated"]}'),
        ("Median / 95th-percentile response time", f'{summary["latency_seconds"]["p50"]:.2f}s / {summary["latency_seconds"]["p95"]:.2f}s'),
    ]
    table = "".join(f"<tr><th scope=\"row\">{e(label)}</th><td>{e(value)}</td></tr>" for label, value in measurements)
    cases = []
    for r in results:
        scope = "Out of scope" if r["expected_refusal"] else "ERP question"
        check = ("Refusal detected" if r["refusal_proxy"] else "No refusal detected") if r["expected_refusal"] else (
            "Strict format met" if r["whw_format"] else "Strict format not met")
        if r["status"] != "ok":
            check = "Request error"
        cases.append(
            f'<details id="model-{e(r["case_id"])}"><summary>{e(r["case_id"])} · {e(scope)} · {e(check)}</summary>'
            f'<h3>Question</h3><p>{e(r["user"])}</p><div class="grid2">'
            f'<div><h3>Reference answer</h3><pre>{e(r["reference"])}</pre></div>'
            f'<div><h3>Recorded model response</h3><pre>{e(r["generated"])}</pre></div></div>'
            f'<p class="small">ROUGE-L F1: {r["rougeL"]:.3f} · Response time: {r["latency_seconds"]:.2f}s. '
            'Format and similarity scores do not establish answer correctness.</p></details>')
    return f"""
    <section id="finetuned-model" aria-labelledby="model-title">
      <div class="section-head"><div><h2 id="model-title">Fine-tuned model evaluation</h2>
      <p>Local Llama 3.1 8B Q4_K_M · ERP procedure guidance and scope refusal · Recorded {e(manifest["started_at"][:10])}</p></div>
      <span class="section-number">04 / MODEL</span></div>
      <p class="small">This benchmark evaluates the downloaded model on its own. Its scores are separate from the employee-registration policy-gate results above.</p>
      <div class="metrics">{cards}</div>
      <div class="grid2"><div class="panel"><h3>Recorded measurements</h3>
      <div class="table-scroll"><table aria-label="Fine-tuned model measurements"><thead><tr><th>Measurement</th><th>Result</th></tr></thead><tbody>{table}</tbody></table></div></div>
      <div class="panel"><h3>What the answers show</h3>
      <p>The model frequently follows the requested format, but some responses introduce unsupported values or change requested details.</p>
      <ul><li><a href="#model-ERP-001">ERP-001</a> adds an amount and cost center absent from the question.</li>
      <li><a href="#model-ERP-004">ERP-004</a> changes the requested fiscal period and year.</li>
      <li><a href="#model-ERP-011">ERP-011</a> adds a quantity and tax code despite scoring above 0.50 ROUGE-L.</li></ul>
      <p class="small">ROUGE measures wording similarity, and refusal detection uses a text heuristic. Factual correctness still requires independent ERP review. No matched base-model comparison was run.</p>
      <details><summary>Benchmark provenance</summary><p class="small">The owner identified this GGUF as the export from <code>{e(manifest["source_notebook"])}</code>.
      The 50-case benchmark was already used by that notebook. The original training file has not been verified; zero exact overlap with available local datasets does not prove an untouched test set.</p>
      <p class="small">Model: <code>{e(manifest["model"])}</code><br>Run: <code>{e(run_dir.name)}</code><br>
      Dataset SHA-256: <code>{e(manifest["dataset_sha256"])}</code></p></details></div></div>
      <div class="panel" style="margin-top:18px"><h3>Explore all {len(results)} model responses</h3>
      <p class="small">Expand a case to compare its question, reference answer and recorded response. Each question was evaluated once in this run.</p>
      {''.join(cases)}</div>
    </section>"""


def render(run_dir: Path, output: Path, model_run_dir: Path = DEFAULT_MODEL_RUN):
    summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
    if summary.get("status") != "complete":
        raise ValueError("A completed evaluation is required")
    manifest = json.loads((run_dir / "manifest.json").read_text(encoding="utf-8"))
    cases = read_jsonl(run_dir / "dataset.jsonl")
    results = read_jsonl(run_dir / "results.jsonl")
    if len(results) != summary["observations"] or len(cases) != summary["unique_cases"]:
        raise ValueError("Dataset/results counts do not match the saved summary")
    safe_manifest = {key: manifest.get(key) for key in (
        "started_at", "finished_at", "as_of_date", "repeat", "concurrency", "model_provider",
        "judge_model", "judge_temperature", "embedding_model", "policy_collection", "top_k",
        "audit_backend", "transport", "scope", "dataset_sha256", "code_revision")}
    data = dict(run=run_dir.name, summary=summary, manifest=safe_manifest,
        inventory=json.loads((run_dir / "inventory.json").read_text(encoding="utf-8")),
        cases=cases, results=results, retrieval=read_jsonl(run_dir / "retrieval.jsonl"),
        policies=json.loads((run_dir / "policy_snapshot.json").read_text(encoding="utf-8")),
        faults=json.loads((run_dir / "faults.json").read_text(encoding="utf-8")))
    # Prevent submitted text from closing the script element. JS renders all
    # case/policy strings through HTML escaping rather than trusting form values.
    encoded = json.dumps(data, ensure_ascii=False).replace("&", "\\u0026").replace("<", "\\u003c").replace(">", "\\u003e")
    template = (ROOT / "docs" / "evaluation_template.html").read_text(encoding="utf-8")
    if template.count("__EVALUATION_DATA__") != 1 or template.count("__MODEL_EVALUATION__") != 1:
        raise ValueError("Expected one placeholder for each evaluation component")
    model_html = model_section(model_run_dir)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(template.replace("__MODEL_EVALUATION__", model_html).replace("__EVALUATION_DATA__", encoded), encoding="utf-8")
    print(f"Created {output.resolve()} ({len(cases)} cases, {len(results)} observations)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_dir", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "docs" / "evaluation.html")
    parser.add_argument("--model-run-dir", type=Path, default=DEFAULT_MODEL_RUN)
    args = parser.parse_args()
    render(args.run_dir, args.output, args.model_run_dir)


if __name__ == "__main__":
    main()

"""Reproducible, live registration benchmark; never creates ERP users.

python -m scripts.eval_registration --prepare-only
python -m scripts.eval_registration --repeat 2 --concurrency 2
See docs/RESEARCH_EVALUATION.md. Synthetic labels require independent review.
"""
import argparse
import asyncio
from collections import Counter, defaultdict
import csv
from datetime import date, datetime
import hashlib
import json
import logging
import math
from pathlib import Path
import platform
import statistics
import subprocess
import time

from scripts.registration_benchmark import build_cases
from src.config.qdrant_client import get_qdrant_client
from src.config.settings import settings
from src.core.registration.corpus import load_corpus
from src.core.registration.gate import SRI_LANKA, evaluate, judge_uncertainty
from src.core.registration.retriever import RegistrationRetriever
from src.core.registration.validation import validate
from src.types.registration import RegistrationRequest

LABELS = ("ALLOW", "BLOCK", "ESCALATE")
# Benchmark relevance judgements are explicit; not copied from retriever output.
GLOBAL = {"EMP-REG-001", "EMP-REG-008", "EMP-REG-009", "EMP-REG-010", "EMP-REG-011"}
PROBES = {
    "phone": ("Sri Lanka employee phone country code and uniqueness", {"EMP-REG-004", "EMP-REG-008"}),
    "location": ("Employee residence must be in Sri Lanka", {"EMP-REG-005"}),
    "email": ("Employee email syntax and active account uniqueness", {"EMP-REG-006", "EMP-REG-008"}),
    "first_name": ("Unicode employee first name and duplicate identity", {"EMP-REG-002", "EMP-REG-008"}),
    "middle_name": ("Optional employee middle name", {"EMP-REG-002"}),
    "last_name": ("Employee surname and duplicate identity", {"EMP-REG-002", "EMP-REG-008"}),
    "gender": ("Allowed gender choices", {"EMP-REG-003"}),
    "birth_date": ("Employee birth date calendar validity and plausibility", {"EMP-REG-003", "EMP-REG-008"}),
    "language": ("Supported employee interface languages", {"EMP-REG-007"}),
    "time_zone": ("Employee canonical timezone Asia Colombo", {"EMP-REG-007"}),
    "requester": ("Administrator authorization to register employee", {"EMP-REG-001"}),
}


def dump(path, obj):
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


def append_json(path, obj):
    with Path(path).open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(obj, ensure_ascii=False) + "\n")


def percentile(values, q):
    if not values:
        return None
    values = sorted(values)
    rank = (len(values) - 1) * q
    low = int(rank)
    return values[low] + (values[min(low + 1, len(values) - 1)] - values[low]) * (rank - low)


def wilson(successes, total):
    if not total:
        return None
    z = 1.959963984540054
    p = successes / total
    divisor = 1 + z * z / total
    center = (p + z * z / (2 * total)) / divisor
    delta = z * math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / divisor
    return [max(0, center - delta), min(1, center + delta)]


def set_scores(rows, key):
    tp = fp = fn = exact = 0
    for r in rows:
        expected, actual = set(r["expected_" + key]), set(r.get(key, []))
        tp += len(expected & actual)
        fp += len(actual - expected)
        fn += len(expected - actual)
        exact += expected == actual and r["predicted"] != "ERROR"
    return {"precision_micro": tp / (tp + fp) if tp + fp else None,
            "recall_micro": tp / (tp + fn) if tp + fn else None,
            "exact_match": exact / len(rows) if rows else None,
            "true_positive": tp, "false_positive": fp, "false_negative": fn}


def metrics(rows):
    n = len(rows)
    matrix = {label: {pred: 0 for pred in (*LABELS, "ERROR")} for label in LABELS}
    for row in rows:
        matrix[row["expected"]][row["predicted"]] += 1
    per_class = {}
    for label in LABELS:
        tp = matrix[label][label]
        support = sum(matrix[label].values())
        predicted = sum(matrix[actual][label] for actual in LABELS)
        precision = tp / predicted if predicted else 0.0
        recall = tp / support if support else 0.0
        per_class[label] = dict(precision=precision, recall=recall,
            f1=2 * precision * recall / (precision + recall) if precision + recall else 0.0, support=support)
    unsafe_population = [r for r in rows if r["expected"] != "ALLOW"]
    unsafe = sum(r["predicted"] == "ALLOW" for r in unsafe_population)
    correct = sum(r["expected"] == r["predicted"] for r in rows)
    return dict(count=n, accuracy=correct / n if n else None,
        macro_f1=statistics.mean(v["f1"] for v in per_class.values()), per_class=per_class,
        confusion_matrix=matrix, unsafe_allow={"numerator": unsafe, "denominator": len(unsafe_population),
            "rate": unsafe / len(unsafe_population) if unsafe_population else None},
        errors=sum(r["predicted"] == "ERROR" for r in rows),
        policy_context_failures=sum("policy_context" in r.get("failed_fields", []) for r in rows),
        full_contract_pass_rate=sum(r.get("passed", False) for r in rows) / n if n else None,
        failed_policies=set_scores(rows, "failed_policies"), failed_fields=set_scores(rows, "failed_fields"),
        latency_seconds={"p50": percentile([r["latency_seconds"] for r in rows], .5),
                         "p95": percentile([r["latency_seconds"] for r in rows], .95)})


def score(case, result, elapsed, run):
    row = dict(case_id=case["case_id"], category=case["category"], repeat=run,
        expected=case["expected_verdict"], predicted=result.verdict, latency_seconds=elapsed,
        expected_failed_policies=case["expected_failed_policies"], expected_failed_fields=case["expected_failed_fields"],
        failed_policies=result.failed_policies, failed_fields=result.failed_fields,
        normalization_correct=all(getattr(result.normalized_employee, key) == value for key, value in case.get("expected_normalized", {}).items()),
        creation_contract_correct=result.can_create == (result.verdict == "ALLOW" and result.audit.get("recorded") is True),
        audit_recorded=result.audit.get("recorded") is True, response=result.model_dump())
    # Citation presence is structural validity, NOT a faithfulness score.
    row["citations_present"] = set(result.failed_policies).issubset(result.retrieved_policies)
    row["passed"] = (row["predicted"] == row["expected"] and
        set(row["failed_policies"]) == set(row["expected_failed_policies"]) and
        set(row["failed_fields"]) == set(row["expected_failed_fields"]) and
        row["normalization_correct"] and row["creation_contract_correct"] and row["audit_recorded"])
    return row


def validate_cases(cases):
    seen = set()
    for case in cases:
        if case["case_id"] in seen:
            raise ValueError("Duplicate benchmark case ID")
        seen.add(case["case_id"])
        RegistrationRequest.model_validate(case["request"])
        if case["expected_verdict"] not in LABELS:
            raise ValueError("Unknown expected verdict")
        for key in ("expected_failed_policies", "expected_failed_fields"):
            if not isinstance(case[key], list):
                raise ValueError(f"{key} must be a list")
        if case["expected_verdict"] == "ALLOW" and (case["expected_failed_fields"] or case["expected_failed_policies"]):
            raise ValueError("ALLOW must have no failed policies/fields")
        for key in case.get("expected_normalized", {}):
            if key not in RegistrationRequest.model_fields["employee"].annotation.model_fields:
                raise ValueError("Unknown normalization field")
    if not cases:
        raise ValueError("Empty benchmark")


def preflight(output):
    client = get_qdrant_client()
    points, offset = client.scroll(settings.POLICY_COLLECTION, limit=256, with_payload=True, with_vectors=False)
    while offset is not None:
        page, offset = client.scroll(settings.POLICY_COLLECTION, offset=offset, limit=256, with_payload=True, with_vectors=False)
        points.extend(page)
    inventory = dict(collection=settings.POLICY_COLLECTION, total_points=len(points),
        policy_ids=dict(Counter((p.payload or {}).get("metadata", {}).get("policy_id", "<missing>") for p in points)),
        flows=dict(Counter((p.payload or {}).get("metadata", {}).get("flow", "<missing>") for p in points)))
    dump(output / "inventory.json", inventory)
    chunks = load_corpus()
    dump(output / "policy_snapshot.json", chunks)
    start = time.perf_counter()
    found = RegistrationRetriever().retrieve()
    inventory["preflight_retrieval_seconds"] = time.perf_counter() - start
    inventory["authoritative_sections"] = len(found)
    inventory["source_policy_ids"] = sorted({c["metadata"]["policy_id"] for c in found})
    dump(output / "inventory.json", inventory)
    return chunks


class TracedClient:
    def __init__(self, client):
        self.client = client
        self.ranked = []

    def __getattr__(self, name):
        return getattr(self.client, name)

    def query_points(self, *args, **kwargs):
        result = self.client.query_points(*args, **kwargs)
        self.ranked = result.points
        return result


def retrieval_benchmark(output, chunks):
    rows = []
    for field, (query, authorities) in PROBES.items():
        relevant = {c["id"] for c in chunks if c["metadata"]["policy_id"] in (authorities | GLOBAL)
                    and (c["metadata"]["policy_id"] in GLOBAL or
                         c["metadata"]["section"] not in {"Gender", "Birth Date", "Language", "Time Zone"} or
                         c["metadata"]["section"].lower().replace(" ", "_") == field)}
        traced = TracedClient(get_qdrant_client())
        start = time.perf_counter()
        returned = RegistrationRetriever(client=traced).retrieve(field, query)
        # Full output is not ranked; compare section content against frozen IDs.
        by_content = {(c["metadata"]["policy_id"], c["metadata"]["section"]): c["id"] for c in chunks}
        actual = {by_content.get((c["metadata"]["policy_id"], c["metadata"]["section"]), "unknown") for c in returned}
        ranked = [str(p.id) for p in traced.ranked]
        row = dict(field=field, query=query, relevant_section_ids=sorted(relevant), final_section_ids=sorted(actual),
            ranked_section_ids=ranked, ranked_scores=[p.score for p in traced.ranked],
            final_required_section_recall=len(relevant & actual) / len(relevant),
            final_precision=len(relevant & actual) / len(actual) if actual else 0,
            metadata_violations=sum(c["metadata"].get("flow") != "employee_registration" or
                c["metadata"].get("active") is not True or c["metadata"].get("country") != "Sri Lanka" for c in returned),
            latency_seconds=time.perf_counter() - start)
        for k in sorted({5, settings.POLICY_TOP_K}):
            selected = set(ranked[:k])
            row[f"semantic_precision_at_{k}"] = len(selected & relevant) / len(selected) if selected else 0
            row[f"semantic_recall_at_{k}"] = len(selected & relevant) / len(relevant)
        rows.append(row)
        append_json(output / "retrieval.jsonl", row)
        print(f"Retrieval {field}: section recall={row['final_required_section_recall']:.3f}", flush=True)
    return rows


def deterministic_baseline(cases, now):
    rows = []
    for case in cases:
        start = time.perf_counter()
        _, findings = validate(RegistrationRequest.model_validate(case["request"]), now.date())
        verdict = "BLOCK" if any(f.verdict == "BLOCK" for f in findings) else "ESCALATE" if findings else "ALLOW"
        rows.append(dict(case_id=case["case_id"], category=case["category"], repeat=1,
            expected=case["expected_verdict"], predicted=verdict, latency_seconds=time.perf_counter() - start,
            expected_failed_policies=case["expected_failed_policies"], expected_failed_fields=case["expected_failed_fields"],
            failed_policies=sorted({f.policy_id for f in findings}), failed_fields=sorted({f.field for f in findings}),
            passed=verdict == case["expected_verdict"]))
    return rows


async def fault_benchmark(output, case, chunks, now):
    """Injected component failures; explicitly separate from live model results."""
    payloads = [{"text": c["text"], "metadata": c["metadata"]} for c in chunks]

    class FixtureRetriever:
        def __init__(self, broken=False):
            self.broken = broken

        def retrieve(self):
            if self.broken:
                raise RuntimeError("Injected retrieval outage")
            return payloads

    async def unavailable(*args):
        raise RuntimeError("Injected judge outage")

    async def accepted(*args):
        return []

    def bad_audit(record):
        raise OSError("Injected audit failure")

    rows = []
    for name in ("retrieval_unavailable", "judge_unavailable", "audit_unavailable"):
        result = await evaluate(RegistrationRequest.model_validate(case["request"]), now=now,
            retriever=FixtureRetriever(name == "retrieval_unavailable"),
            judge=unavailable if name == "judge_unavailable" else accepted,
            audit_writer=bad_audit if name == "audit_unavailable" else None)
        row = dict(name=name, methodology="injected failure with fixture dependencies", expected="ESCALATE",
            predicted=result.verdict, can_create=result.can_create,
            passed=result.verdict == "ESCALATE" and not result.can_create, response=result.model_dump())
        rows.append(row)
    dump(output / "faults.json", rows)
    return rows


def write_report(output, rows, baseline, retrieval, faults, manifest):
    # Repeats are not independent samples: CI uses first observation per case.
    first = [r for r in rows if r["repeat"] == 1]
    unsafe_first = [r for r in first if r["expected"] != "ALLOW"]
    grouped = defaultdict(list)
    for row in rows:
        grouped[row["case_id"]].append(row["predicted"])
    repeated = [v for v in grouped.values() if len(v) > 1]
    summary = dict(status="complete", observations=len(rows), unique_cases=len(first),
        live=metrics(rows), deterministic_baseline=metrics(baseline),
        first_run_accuracy_wilson_95=wilson(sum(r["expected"] == r["predicted"] for r in first), len(first)),
        first_run_unsafe_allow_wilson_95=wilson(sum(r["predicted"] == "ALLOW" for r in unsafe_first), len(unsafe_first)),
        consistency={"repeated_cases": len(repeated), "identical_verdict_fraction": sum(len(set(v)) == 1 for v in repeated) / len(repeated) if repeated else None},
        per_category={category: metrics([r for r in rows if r["category"] == category]) for category in sorted({r["category"] for r in rows})},
        retrieval={key: statistics.mean(r[key] for r in retrieval) for key in retrieval[0] if key.startswith(("final_", "semantic_")) and isinstance(retrieval[0][key], (float, int))} if retrieval else {},
        fault_checks_passed=sum(r["passed"] for r in faults), fault_checks_total=len(faults),
        human_explanation_review="pending; structural citations are not semantic faithfulness",
        scope=manifest["scope"])
    dump(output / "summary.json", summary)
    with (output / "results.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        columns = ["case_id", "category", "repeat", "expected", "predicted", "passed", "latency_seconds", "failed_policies", "failed_fields"]
        writer = csv.DictWriter(stream, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
    with (output / "explanation_review.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        columns = ["case_id", "repeat", "expected", "predicted", "justification", "failed_policies", "reviewer", "supported_by_policy", "identifies_input_problem", "actionable", "invented_rule", "notes"]
        writer = csv.DictWriter(stream, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows({**r, "justification": r.get("response", {}).get("justification", "")} for r in rows)
    main = summary["live"]
    lines = ["# Employee-registration RAG evaluation", "", manifest["scope"], "",
        "Synthetic, policy-derived labels have NOT been independently reviewed. This is a development benchmark, not an untouched final test set.", "",
        f"- Unique cases: {len(first)}; observations: {len(rows)}",
        f"- Verdict accuracy: {main['accuracy']:.2%}", f"- Macro F1: {main['macro_f1']:.4f}",
        f"- Full decision/field/policy/normalization/audit contract pass rate: {main['full_contract_pass_rate']:.2%}",
        f"- Unsafe ALLOW: {main['unsafe_allow']['numerator']}/{main['unsafe_allow']['denominator']}",
        f"- Runtime errors: {main['errors']}; policy-context failures: {main['policy_context_failures']}",
        f"- Latency p50/p95: {main['latency_seconds']['p50']:.3f}s / {main['latency_seconds']['p95']:.3f}s",
        f"- Deterministic-only verdict accuracy: {summary['deterministic_baseline']['accuracy']:.2%}",
        f"- Injected fault checks: {summary['fault_checks_passed']}/{len(faults)}", "",
        "Confusion matrix (rows expected, columns predicted):", "", "| Expected | ALLOW | BLOCK | ESCALATE | ERROR |", "|---|---:|---:|---:|---:|"]
    for label, counts in main["confusion_matrix"].items():
        lines.append(f"| {label} | " + " | ".join(str(counts[p]) for p in (*LABELS, "ERROR")) + " |")
    lines += ["", "## Interpretation limits", "",
        "- Live calls execute local gate code with configured hosted Qdrant, embeddings and judge. Azure ingress/authentication/network latency is not tested.",
        "- Audits use a real, isolated local JSONL sink for this run, not the hosted production audit collection.",
        "- Metadata retrieves the complete authoritative corpus. Semantic ranking is reported separately on 11 field probes; this is a small provisional retrieval set.",
        "- Semantic precision divides by returned results up to k (short result sets are not padded). Global governance sections count as relevant.",
        "- Deterministic baseline omits narrative checks and is an experimental comparator, not an alternative safe deployment.",
        "- Confidence intervals use the first repetition only; templated synthetic cases are not a random sample of real employees.",
        "- Explanation correctness requires filling explanation_review.csv; no automatic faithfulness score is claimed.",
        "- Missing-policy, stale-version and API authentication checks remain covered by the separate unit/integration suite, not these three injected outages.", "",
        "## Failed cases", ""]
    lines.extend(f"- {r['case_id']} repeat {r['repeat']}: expected {r['expected']}, got {r['predicted']}; policies={r.get('failed_policies', [])}; fields={r.get('failed_fields', [])}" for r in rows if not r.get("passed"))
    (output / "REPORT.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return summary


async def run(args):
    now = datetime.combine(date.fromisoformat(args.as_of) if args.as_of else datetime.now(SRI_LANKA).date(), datetime.min.time(), tzinfo=SRI_LANKA).replace(hour=12)
    output = Path(args.output or f"var/evaluations/{datetime.now(SRI_LANKA):%Y%m%dT%H%M%S%f}")
    output.mkdir(parents=True, exist_ok=False)
    cases = [json.loads(line) for line in Path(args.dataset).read_text(encoding="utf-8-sig").splitlines() if line.strip()] if args.dataset else build_cases(now.date())
    if args.limit:
        cases = cases[:args.limit]
    validate_cases(cases)
    for case in cases:
        append_json(output / "dataset.jsonl", case)
    root = Path(__file__).resolve().parents[1]
    source_hashes = {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for directory in (root / "src", root / "scripts") for p in directory.rglob("*.py")}
    revision = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=False).stdout.strip()
    manifest = dict(started_at=datetime.now(SRI_LANKA).isoformat(), as_of_date=str(now.date()), python=platform.python_version(),
        code_revision=revision, source_sha256=source_hashes, dataset_sha256=hashlib.sha256((output / "dataset.jsonl").read_bytes()).hexdigest(),
        label_status="See per-case label_status; built-in cases are synthetic and not independently reviewed",
        case_counts=dict(Counter(c["expected_verdict"] for c in cases)), repeat=args.repeat, concurrency=args.concurrency,
        model_provider=settings.MODEL_PROVIDER, judge_model=settings.JUDGE_MODEL, judge_temperature=0,
        embedding_model=settings.API_EMBED_MODEL if settings.MODEL_PROVIDER in ("api", "openrouter") else settings.EMBED_MODEL,
        policy_collection=settings.POLICY_COLLECTION, top_k=settings.POLICY_TOP_K,
        email_domains_configured=bool(settings.REGISTRATION_EMAIL_DOMAINS), utc_offset_mapping=settings.REGISTRATION_MAP_UTC_OFFSET,
        scope="Employee registration EMP-REG-001 through EMP-REG-011 only; other database collections and flows are outside this evaluation.",
        audit_backend="isolated local file", transport="in-process gate with live configured dependencies")
    dump(output / "manifest.json", manifest)
    print(f"Output: {output.resolve()} | {len(cases)} cases | {manifest['case_counts']}", flush=True)
    if args.prepare_only:
        print("Prepared dataset only; no live calls made.")
        return 0
    if not args.dataset and (settings.REGISTRATION_EMAIL_DOMAINS or settings.REGISTRATION_MAP_UTC_OFFSET):
        raise ValueError("Built-in labels assume no domain restriction and no UTC-offset mapping; supply a reviewed --dataset for other configurations")
    settings.REGISTRATION_AUDIT_BACKEND = "file"
    settings.REGISTRATION_AUDIT_PATH = str(output / "audit.jsonl")
    # Provider exception messages can include request details: retain sanitized
    # exception types in results rather than raw SDK logs or secret-bearing URLs.
    logging.disable(logging.CRITICAL)
    try:
        chunks = await asyncio.to_thread(preflight, output)
        retrieval = await asyncio.to_thread(retrieval_benchmark, output, chunks)
    except Exception as exc:
        dump(output / "summary.json", {"status": "preflight_failed", "error_type": type(exc).__name__, "detail": "Live dependency or authoritative corpus verification failed; no decision benchmark was run."})
        print(f"Preflight failed: {type(exc).__name__}; see {output / 'summary.json'}", flush=True)
        return 2
    baseline = deterministic_baseline(cases, now)
    for row in baseline:
        append_json(output / "baseline.jsonl", row)
    rows = []
    semaphore = asyncio.Semaphore(args.concurrency)

    async def one(case, repetition):
        async with semaphore:
            start = time.perf_counter()
            timings = {}

            class TimedRetriever(RegistrationRetriever):
                def retrieve(self, *a, **kw):
                    before = time.perf_counter()
                    try:
                        result = super().retrieve(*a, **kw)
                        timings["retrieved_sections"] = [{"policy_id": c["metadata"]["policy_id"], "section": c["metadata"]["section"]} for c in result]
                        return result
                    finally:
                        timings["retrieval_seconds"] = time.perf_counter() - before

            async def timed_judge(*a):
                before = time.perf_counter()
                try:
                    return await judge_uncertainty(*a)
                finally:
                    timings["judge_seconds"] = time.perf_counter() - before

            try:
                result = await asyncio.wait_for(evaluate(RegistrationRequest.model_validate(case["request"]),
                    now=now, retriever=TimedRetriever(), judge=timed_judge), timeout=args.timeout)
                row = score(case, result, time.perf_counter() - start, repetition)
            except Exception as exc:
                row = dict(case_id=case["case_id"], category=case["category"], repeat=repetition,
                    expected=case["expected_verdict"], predicted="ERROR", error_type=type(exc).__name__,
                    expected_failed_policies=case["expected_failed_policies"], expected_failed_fields=case["expected_failed_fields"],
                    failed_policies=[], failed_fields=[], passed=False, latency_seconds=time.perf_counter() - start)
            row.update(timings)
            rows.append(row)
            append_json(output / "results.jsonl", row)
            print(f"{len(rows)}/{len(cases)*args.repeat} {'PASS' if row['passed'] else 'FAIL'} {case['case_id']} repeat={repetition} {row['expected']}->{row['predicted']} {row['latency_seconds']:.2f}s", flush=True)

    # Separate passes prevent overlapping repeats of the same case.
    for repetition in range(1, args.repeat + 1):
        await asyncio.gather(*(one(case, repetition) for case in cases))
    canonical = build_cases(now.date())[0]
    faults = await fault_benchmark(output, canonical, chunks, now)
    rows.sort(key=lambda r: (r["case_id"], r["repeat"]))
    manifest["finished_at"] = datetime.now(SRI_LANKA).isoformat()
    dump(output / "manifest.json", manifest)
    summary = write_report(output, rows, baseline, retrieval, faults, manifest)
    print(f"Accuracy={summary['live']['accuracy']:.2%}; macro F1={summary['live']['macro_f1']:.4f}; report={output / 'REPORT.md'}", flush=True)
    return 1 if any(not r["passed"] for r in rows + faults) else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", help="Optional independently labelled JSONL using the exported dataset schema")
    parser.add_argument("--output", help="New output directory (existing directories are never overwritten)")
    parser.add_argument("--prepare-only", action="store_true", help="Export and validate dataset without network calls")
    parser.add_argument("--as-of", help="Freeze validation date as YYYY-MM-DD; default Sri Lankan current date")
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--limit", type=int, help="Run a subset for smoke checking; not a full benchmark")
    parser.add_argument("--timeout", type=float, default=150)
    args = parser.parse_args()
    if args.repeat < 1 or args.concurrency < 1 or args.timeout <= 0 or (args.limit is not None and args.limit < 1):
        parser.error("repeat, concurrency, limit and timeout must be positive")
    raise SystemExit(asyncio.run(run(args)))


if __name__ == "__main__":
    main()

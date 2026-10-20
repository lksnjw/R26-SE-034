#!/usr/bin/env python3
"""
Step 1 of the Policy Gate run sheet: find out what is actually in your dataset.

Run BEFORE any training, labelling, or splitting.

    python inspect_dataset.py ft_data/your_data.jsonl

What it does
    1. Detects your JSONL schema (works with instruction/output, prompt/completion,
       question/answer, or OpenAI-style messages).
    2. Counts records and reports field coverage.
    3. Estimates token lengths and tells you whether max_seq_length=1024 is enough.
    4. Checks how many reference answers actually follow the WHW contract.
    5. Finds exact duplicates and near-duplicates.
    6. Guesses the in-scope / out-of-scope / adversarial balance.
    7. Writes a deduplicated copy you can build your splits from.

Dependencies: standard library only for the core report.
Optional, for better near-duplicate detection:  pip install scikit-learn
Optional, for exact token counts:               pip install transformers
"""

import argparse
import hashlib
import json
import os
import re
import sys
from collections import Counter, defaultdict

# ----------------------------------------------------------------------------
# terminal helpers
# ----------------------------------------------------------------------------

USE_COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def c(text, code):
    return f"\033[{code}m{text}\033[0m" if USE_COLOR else text


def bold(t):
    return c(t, "1")


def red(t):
    return c(t, "31")


def green(t):
    return c(t, "32")


def yellow(t):
    return c(t, "33")


def dim(t):
    return c(t, "2")


def header(title):
    print()
    print(bold(title))
    print(dim("-" * max(len(title), 60)))


def verdict(ok, warn, message):
    """Print a PASS / WARN / FAIL line."""
    if ok:
        print(f"  {green('PASS')}  {message}")
    elif warn:
        print(f"  {yellow('WARN')}  {message}")
    else:
        print(f"  {red('FAIL')}  {message}")


def bar(count, total, width=34):
    if total <= 0:
        return ""
    filled = int(round(width * count / total))
    return "#" * filled + dim("." * (width - filled))


# ----------------------------------------------------------------------------
# loading
# ----------------------------------------------------------------------------

# Field-name pairs we know how to read, in priority order.
SCHEMA_CANDIDATES = [
    ("instruction", "output"),
    ("instruction", "response"),
    ("prompt", "completion"),
    ("prompt", "response"),
    ("question", "answer"),
    ("input", "output"),
    ("user", "assistant"),
    ("query", "response"),
]

CONTEXT_FIELDS = ["input", "context", "policy", "retrieved", "system"]


def load_records(path):
    """Read JSONL, tolerating blank lines and reporting malformed ones."""
    records, malformed = [], []
    with open(path, "r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as exc:
                malformed.append((lineno, str(exc)[:70]))
    return records, malformed


def detect_schema(records):
    """Return (question_field, answer_field, style)."""
    keys = Counter()
    for rec in records[:500]:
        if isinstance(rec, dict):
            keys.update(rec.keys())

    if "messages" in keys:
        return None, None, "messages"

    for q, a in SCHEMA_CANDIDATES:
        if keys.get(q, 0) and keys.get(a, 0):
            return q, a, "pair"

    return None, None, "unknown"


def extract(rec, qf, af, style):
    """Pull (question, answer, context) out of one record."""
    if style == "messages":
        msgs = rec.get("messages", [])
        q = a = ctx = ""
        for m in msgs:
            role, content = m.get("role", ""), m.get("content", "") or ""
            if role == "user" and not q:
                q = content
            elif role == "assistant" and not a:
                a = content
            elif role == "system" and not ctx:
                ctx = content
        return q, a, ctx

    q = rec.get(qf, "") or ""
    a = rec.get(af, "") or ""
    ctx = ""
    for f in CONTEXT_FIELDS:
        if f in (qf, af):
            continue
        val = rec.get(f)
        if isinstance(val, str) and val.strip():
            ctx = val
            break
    return q, a, ctx


# ----------------------------------------------------------------------------
# token counting
# ----------------------------------------------------------------------------

def get_token_counter():
    """Prefer a real tokenizer; fall back to a character heuristic."""
    for model_id in ("meta-llama/Llama-3.2-3B-Instruct", "NousResearch/Meta-Llama-3.1-8B"):
        try:
            from transformers import AutoTokenizer
            tok = AutoTokenizer.from_pretrained(model_id)
            return (lambda s: len(tok.encode(s, add_special_tokens=False))), f"tokenizer ({model_id})"
        except Exception:
            continue
    # ~3.6 chars per token is a reasonable English/Llama-3 approximation
    return (lambda s: max(1, int(len(s) / 3.6))), "character estimate (install transformers for exact counts)"


def percentile(sorted_vals, pct):
    if not sorted_vals:
        return 0
    idx = min(len(sorted_vals) - 1, int(round((pct / 100.0) * (len(sorted_vals) - 1))))
    return sorted_vals[idx]


# ----------------------------------------------------------------------------
# content checks
# ----------------------------------------------------------------------------

WHW_RE = [re.compile(p, re.IGNORECASE) for p in (r"\bWHAT\s*:", r"\bHOW\s*:", r"\bWHY\s*:")]
BLOCK_RE = re.compile(r"ACTION\s+BLOCKED", re.IGNORECASE)
NONERP_RE = re.compile(r"NON[-_]ERP[-_]CONTEXT", re.IGNORECASE)

ADVERSARIAL_HINTS = [
    "bypass", "firewall", "malware", "steal", "password", "credential",
    "hack", "exploit", "jailbreak", "ignore previous", "ignore all previous",
    "disregard", "sudo", "root access", "keylogger", "ransomware", "phishing",
]

MODULE_HINTS = {
    "HR / payroll": ["payroll", "employee", "hr ", "salary", "wage", "leave", "hiring", "recruit"],
    "Finance / assets": ["depreciation", "asset", "ledger", "journal", "invoice", "gl ", "accounting", "posting period"],
    "Procurement": ["procurement", "purchase order", "vendor", "supplier", "requisition", " po ", "source list"],
    "Warehouse / inventory": ["warehouse", "inventory", "stock", "goods receipt", "material", "physical inventory"],
    "Sales": ["sales order", "customer", "delivery", "billing", "quotation"],
}


def is_whw(text):
    return all(rx.search(text) for rx in WHW_RE)


def is_refusal(text):
    return bool(BLOCK_RE.search(text) and NONERP_RE.search(text))


def looks_adversarial(text):
    low = text.lower()
    return any(h in low for h in ADVERSARIAL_HINTS)


def guess_module(text):
    low = text.lower()
    for module, hints in MODULE_HINTS.items():
        if any(h in low for h in hints):
            return module
    return "unclassified"


# ----------------------------------------------------------------------------
# duplicate detection
# ----------------------------------------------------------------------------

def normalize(text):
    return re.sub(r"[^a-z0-9 ]+", "", text.lower()).strip()


def exact_duplicates(questions):
    seen, dupes = {}, defaultdict(list)
    for i, q in enumerate(questions):
        h = hashlib.md5(normalize(q).encode("utf-8")).hexdigest()
        if h in seen:
            dupes[seen[h]].append(i)
        else:
            seen[h] = i
    return dupes


def near_duplicates(questions, threshold=0.92):
    """TF-IDF nearest-neighbour search. Returns (pairs, method, error)."""
    try:
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.neighbors import NearestNeighbors
    except ImportError:
        return None, None, "scikit-learn not installed"

    try:
        vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5), min_df=2, max_features=60000)
        X = vec.fit_transform(questions)
        k = min(6, len(questions))
        nn = NearestNeighbors(n_neighbors=k, metric="cosine").fit(X)
        distances, indices = nn.kneighbors(X)

        pairs = set()
        for i in range(len(questions)):
            for dist, j in zip(distances[i][1:], indices[i][1:]):
                if 1.0 - dist >= threshold:
                    pairs.add((min(i, int(j)), max(i, int(j))))
        return pairs, "TF-IDF char n-gram cosine", None
    except Exception as exc:
        return None, None, f"{type(exc).__name__}: {exc}"


def collapse(n_items, pairs):
    """Union-find over near-duplicate pairs; return indices to drop."""
    parent = list(range(n_items))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for a, b in pairs:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    groups = defaultdict(list)
    for i in range(n_items):
        groups[find(i)].append(i)

    drop = set()
    for root, members in groups.items():
        for m in sorted(members)[1:]:
            drop.add(m)
    return drop


# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Inspect an instruction-tuning dataset before training.")
    ap.add_argument("path", help="path to your .jsonl dataset")
    ap.add_argument("--max-seq-length", type=int, default=1024,
                    help="the max_seq_length you plan to train with (default 1024)")
    ap.add_argument("--near-dup-threshold", type=float, default=0.92,
                    help="cosine similarity above which two questions count as near-duplicates")
    ap.add_argument("--out", default=None,
                    help="write the deduplicated dataset here (default: <input>.dedup.jsonl)")
    ap.add_argument("--no-write", action="store_true", help="report only, write nothing")
    args = ap.parse_args()

    if not os.path.exists(args.path):
        print(red(f"File not found: {args.path}"))
        return 1

    print()
    print(bold("  DATASET INSPECTION"))
    print(dim(f"  {args.path}"))

    # ---- load -------------------------------------------------------------
    records, malformed = load_records(args.path)
    if not records:
        print(red("\nNo readable records found."))
        return 1

    qf, af, style = detect_schema(records)

    header("1. STRUCTURE")
    print(f"  Records read          {bold(f'{len(records):,}')}")
    if malformed:
        verdict(False, False, f"{len(malformed)} malformed line(s), first at line {malformed[0][0]}")
    else:
        verdict(True, False, "every line parsed as valid JSON")

    if style == "unknown":
        print(red("\n  Could not identify the question/answer fields."))
        keys = Counter()
        for rec in records[:500]:
            if isinstance(rec, dict):
                keys.update(rec.keys())
        print("  Fields present: " + ", ".join(f"{k} ({v})" for k, v in keys.most_common()))
        print(dim("  Add your field names to SCHEMA_CANDIDATES at the top of this script."))
        return 1

    if style == "messages":
        print(f"  Schema                {bold('OpenAI messages format')}")
    else:
        print(f"  Schema                {bold(qf)} -> {bold(af)}")

    all_keys = Counter()
    for rec in records:
        if isinstance(rec, dict):
            all_keys.update(rec.keys())
    print(f"  Fields                " + ", ".join(f"{k} {dim(f'({v:,})')}" for k, v in all_keys.most_common()))

    # ---- extract ----------------------------------------------------------
    questions, answers, contexts = [], [], []
    empty_q = empty_a = 0
    for rec in records:
        q, a, ctx = extract(rec, qf, af, style)
        if not q.strip():
            empty_q += 1
        if not a.strip():
            empty_a += 1
        questions.append(q)
        answers.append(a)
        contexts.append(ctx)

    if empty_q or empty_a:
        verdict(False, True, f"{empty_q} empty question(s), {empty_a} empty answer(s)")

    has_context = sum(1 for x in contexts if x.strip())
    print(f"  Records with context  {bold(f'{has_context:,}')} {dim(f'({has_context/len(records)*100:.0f}%)')}")
    if has_context == 0:
        verdict(False, True, "no retrieved-context field found — this is the train/serve skew risk")
        print(dim("        If you serve with RAG context, your training prompts need it too."))

    # ---- token lengths ----------------------------------------------------
    header("2. TOKEN LENGTHS")
    count_tokens, method = get_token_counter()
    print(dim(f"  Counted with: {method}"))

    totals = []
    for q, a, ctx in zip(questions, answers, contexts):
        totals.append(count_tokens(q) + count_tokens(a) + count_tokens(ctx))
    totals.sort()

    limit = args.max_seq_length
    over = sum(1 for t in totals if t > limit)
    pct_over = over / len(totals) * 100

    print(f"  Median                {bold(str(percentile(totals, 50)))} tokens")
    print(f"  90th percentile       {bold(str(percentile(totals, 90)))} tokens")
    print(f"  99th percentile       {bold(str(percentile(totals, 99)))} tokens")
    print(f"  Longest               {bold(str(totals[-1]))} tokens")
    print()
    verdict(pct_over < 1, pct_over < 5,
            f"{over:,} records ({pct_over:.1f}%) exceed max_seq_length={limit} and would be truncated")

    over_512 = sum(1 for t in totals if t > 512)
    if over_512:
        print(dim(f"        For reference: {over_512:,} ({over_512/len(totals)*100:.1f}%) exceed 512 — "
                  f"the value your current config uses."))

    suggested = 512
    for cand in (512, 768, 1024, 1536, 2048, 3072, 4096):
        if percentile(totals, 99) <= cand:
            suggested = cand
            break
    else:
        suggested = 4096
    print(f"\n  Suggested max_seq_length: {bold(str(suggested))} "
          f"{dim('(covers the 99th percentile, rounded up)')}")

    # ---- format adherence -------------------------------------------------
    header("3. REFERENCE ANSWER FORMAT")
    whw = sum(1 for a in answers if is_whw(a))
    refusal = sum(1 for a in answers if is_refusal(a))
    neither = len(answers) - whw
    print(f"  Follow WHW structure  {bold(f'{whw:,}')} {dim(f'({whw/len(answers)*100:.1f}%)')}")
    print(f"  Contain refusal marks {bold(f'{refusal:,}')} {dim(f'({refusal/len(answers)*100:.1f}%)')}")
    print()
    verdict(neither == 0, neither / len(answers) < 0.05,
            f"{neither:,} reference answer(s) do NOT follow the WHW contract")
    if neither:
        print(dim("        The model cannot learn a format its own training targets break."))
        print(dim("        Fix or drop these before training."))
        for i, a in enumerate(answers):
            if not is_whw(a):
                print(dim(f'        e.g. record {i}: "{a.strip()[:90]}..."'))
                break

    # ---- balance ----------------------------------------------------------
    header("4. BALANCE")
    n_refusal = sum(1 for a in answers if is_refusal(a))
    n_inscope = len(answers) - n_refusal
    n_adversarial = sum(1 for q in questions if looks_adversarial(q))

    print(f"  In-scope (answered)   {bold(f'{n_inscope:,}'):>14} {bar(n_inscope, len(answers))}")
    print(f"  Out-of-scope (refused){bold(f'{n_refusal:,}'):>14} {bar(n_refusal, len(answers))}")
    print(f"  Adversarial phrasing  {bold(f'{n_adversarial:,}'):>14} {bar(n_adversarial, len(answers))}")
    print()
    ratio = n_refusal / max(1, len(answers))
    verdict(0.2 <= ratio <= 0.5, 0.1 <= ratio <= 0.6,
            f"refusal examples are {ratio*100:.0f}% of the set "
            f"{dim('(20-40% is a healthy range for a governance model)')}")

    print(f"\n  {dim('Module distribution (keyword guess — you will refine this when labelling):')}")
    modules = Counter(guess_module(q) for q in questions)
    for module, n in modules.most_common():
        print(f"    {module:<22} {bold(f'{n:,}'):>10}  {bar(n, len(questions), 26)}")
    if modules.get("unclassified", 0) / len(questions) > 0.4:
        print(dim("\n        Most records did not match a module keyword. You will need to add a"))
        print(dim("        `module` field by hand or from however the data was generated —"))
        print(dim("        it is what makes a held-out-module OOD split possible."))

    # ---- duplicates -------------------------------------------------------
    header("5. DUPLICATES")
    exact = exact_duplicates(questions)
    n_exact = sum(len(v) for v in exact.values())
    print(f"  Exact duplicate questions   {bold(f'{n_exact:,}')} {dim(f'({n_exact/len(questions)*100:.1f}%)')}")

    pairs, dup_method, err = near_duplicates(questions, args.near_dup_threshold)
    drop = set()
    for first, rest in exact.items():
        drop.update(rest)

    if pairs is None:
        print(f"  Near-duplicates             {yellow('skipped')} {dim(f'({err})')}")
        print(dim("        Install scikit-learn to enable this — it matters more than exact dupes."))
    else:
        near_drop = collapse(len(questions), pairs)
        only_near = near_drop - drop
        print(f"  Near-duplicate questions    {bold(f'{len(only_near):,}')} "
              f"{dim(f'(cosine >= {args.near_dup_threshold}, {dup_method})')}")
        drop |= near_drop

    unique = len(questions) - len(drop)
    print()
    print(f"  Unique records remaining    {bold(f'{unique:,}')} of {len(questions):,} "
          f"{dim(f'({unique/len(questions)*100:.0f}%)')}")
    dup_rate = len(drop) / len(questions)
    verdict(dup_rate < 0.05, dup_rate < 0.20,
            f"{len(drop):,} redundant record(s) ({dup_rate*100:.0f}%)")
    if dup_rate >= 0.05:
        print(dim("        Near-duplicates spanning your train/test split inflate every"))
        print(dim("        number you report. Remove them BEFORE splitting, not after."))

    # ---- write ------------------------------------------------------------
    if not args.no_write and drop:
        out = args.out or (os.path.splitext(args.path)[0] + ".dedup.jsonl")
        with open(out, "w", encoding="utf-8") as fh:
            for i, rec in enumerate(records):
                if i not in drop:
                    fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        header("6. OUTPUT")
        print(f"  Deduplicated dataset written to {bold(out)}")
        print(f"  {unique:,} records. Build your splits from this file, not the original.")

    # ---- what to do next --------------------------------------------------
    header("WHAT THIS MEANS")
    todo = []
    if neither:
        todo.append(f"Fix or drop the {neither:,} reference answers that break the WHW contract.")
    if pct_over >= 1:
        todo.append(f"Set max_seq_length={suggested} (not 512 — that truncates {over_512:,} records mid-answer).")
    if has_context == 0:
        todo.append("Add retrieved policy context to your training prompts, or you will have train/serve skew.")
    if dup_rate >= 0.05:
        todo.append(f"Use the deduplicated file ({unique:,} records) as the basis for your splits.")
    if modules.get("unclassified", 0) / len(questions) > 0.4:
        todo.append("Add a `module` field so you can hold one module out as an OOD test set.")
    if not (0.2 <= ratio <= 0.5):
        todo.append(f"Rebalance refusals — currently {ratio*100:.0f}% of the set.")

    if todo:
        for i, item in enumerate(todo, 1):
            print(f"  {i}. {item}")
    else:
        print(green("  Dataset looks clean. Proceed to labelling and splitting."))

    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
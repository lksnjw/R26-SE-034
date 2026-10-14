"""
Which finance scenarios does the rule set actually govern?

Reads the live policy collection, scores every registered action against the
decision dimensions in `src/core/policy/coverage.py`, and prints what nobody has
written a rule for.

Run from the rag-system directory:
    .venv/Scripts/python.exe -m scripts.coverage_report
    .venv/Scripts/python.exe -m scripts.coverage_report --gaps   (gap list only)

A gap here is silent in production: retrieval succeeds, the judge sees no rule on
the subject, and the action is allowed on the strength of the rules that do exist.
Nothing in the logs will say a rule was missing, because nothing was missing —
it was never written.
"""
import argparse
import sys

from src.core.actions.action_registry import REGISTRY_VERSION, all_actions, get_action
from src.core.policy.coverage import DIMENSIONS, analyse
from src.core.policy.policy_retriever import get_policy_retriever
from src.config.settings import settings

MARK = {True: "  yes  ", False: "   --  "}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gaps", action="store_true", help="print only the gap list")
    args = parser.parse_args()

    retriever = get_policy_retriever()
    actions = [spec.name.value for spec in all_actions()]

    governing = {action: retriever.governing(action) for action in actions}
    report = analyse(governing)

    print("=" * 100)
    print(f"POLICY COVERAGE - collection '{settings.POLICY_COLLECTION}' "
          f"| {retriever.corpus_size()} chunks | registry v{REGISTRY_VERSION}")
    print("=" * 100)

    if not args.gaps:
        keys = [d.key for d in DIMENSIONS]
        header = f"{'action':<28}" + "".join(f"{k[:9]:^9}" for k in keys)
        print(f"\n{header}")
        print("-" * len(header))
        for row in report:
            spec = get_action(row.action)
            line = f"{row.action:<28}"
            for dimension in DIMENSIONS:
                if spec.name not in dimension.applies_to:
                    line += f"{'.':^9}"          # not applicable to this action
                else:
                    line += f"{MARK[dimension.key in row.covered]:^9}"
            print(line)
        print("\n  yes = a governing clause addresses it   -- = GAP   . = not applicable")

    # ── Gaps, grouped by dimension: one missing rule usually covers several
    # actions at once, so this is the order the writing should be done in.
    by_dimension: dict[str, list[str]] = {}
    for row in report:
        for dimension in row.missing:
            by_dimension.setdefault(dimension.key, []).append(row.action)

    print("\n" + "=" * 100)
    if not by_dimension:
        print("no gaps: every applicable dimension has at least one governing clause")
    else:
        total = sum(len(v) for v in by_dimension.values())
        print(f"GAPS - {total} action/dimension pair(s) with no governing rule")
        print("=" * 100)
        for dimension in DIMENSIONS:
            affected = by_dimension.get(dimension.key)
            if not affected:
                continue
            print(f"\n  {dimension.title.upper()}  ({dimension.key})")
            print(f"    risk    : {dimension.risk}")
            print(f"    affects : {', '.join(affected)}")

    uncovered = [r.action for r in report if not r.has_specific_policy]
    if uncovered:
        print(f"\n  NO SPECIFIC POLICY AT ALL: {', '.join(uncovered)}")
        print("    these actions are decided on mandatory rules alone")

    print("\n" + "=" * 100)
    worst = sorted(report, key=lambda r: len(r.missing), reverse=True)[:3]
    for row in worst:
        print(f"  {row.action:<28} {row.score} dimensions covered")
    print("=" * 100)

    # Textual detection is a heuristic in both directions — say so every run,
    # so a clean report is never mistaken for a proof of completeness.
    print("\nStructured dimensions (authority, threshold, segregation) are read from")
    print("front-matter and are reliable. The rest are keyword-matched against clause")
    print("text: a 'yes' means a human should confirm, not that the rule is sound.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

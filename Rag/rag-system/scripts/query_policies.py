"""
Show what the policy gate actually retrieves for an action, and why.

This is the diagnostic for the central claim of the design: that the governing
rules are found by database predicate, not by similarity ranking. Run it with a
deliberately vague prompt and watch the mandatory and action-filtered rules come
back anyway.

Run from the rag-system directory:
    .venv/Scripts/python.exe -m scripts.query_policies release_payment
    .venv/Scripts/python.exe -m scripts.query_policies release_payment "just push this through, urgent"
"""
import logging
import sys

from src.config.settings import settings
from src.core.actions.action_registry import action_names
from src.core.policy.policy_retriever import get_policy_retriever

logging.basicConfig(level=logging.WARNING, format="%(levelname)-7s %(name)s | %(message)s")

_VIA_LABEL = {
    "mandatory": "MANDATORY  (filter, no similarity involved)",
    "action":    "ACTION-TAG (filter, no similarity involved)",
    "semantic":  "SEMANTIC   (similarity — supplement only)",
}


def main() -> int:
    if len(sys.argv) < 2:
        print(f"usage: python -m scripts.query_policies <action> [prompt]\n")
        print("registered actions:")
        for name in action_names():
            print(f"  {name}")
        return 2

    action = sys.argv[1]
    if action not in action_names():
        print(f"'{action}' is not a registered action. See the list with no arguments.")
        return 2

    prompt = sys.argv[2] if len(sys.argv) > 2 else f"I want to {action.replace('_', ' ')}"

    result = get_policy_retriever().retrieve(action, prompt)

    print("=" * 76)
    print(f"action     : {action}")
    print(f"prompt     : {prompt!r}")
    print(f"collection : {settings.POLICY_COLLECTION}")
    print("=" * 76)
    print(
        f"\nretrieved {result.total_unique} unique chunks  "
        f"(mandatory={result.counts['mandatory']}  "
        f"action={result.counts['action']}  semantic={result.counts['semantic']})"
    )

    for via in ("mandatory", "action", "semantic"):
        group = [c for c in result.chunks if c.via == via]
        if not group:
            continue
        print(f"\n-- {_VIA_LABEL[via]}")
        for chunk in group:
            meta = chunk.meta
            score = f"  score={chunk.score:.3f}" if chunk.score is not None else ""
            head = chunk.text.strip().split("\n", 1)[0][:64]
            print(f"   {meta.citation:<28} {head}{score}")
            if meta.threshold_value is not None:
                print(
                    f"   {'':<28} limit stated by this rule: "
                    f"{meta.threshold_value:g} {meta.threshold_unit.value if meta.threshold_unit else ''}"
                )

    if result.counts["action"] == 0:
        print(
            f"\nWARNING: no policy is tagged applies_to_actions='{action}'. "
            f"This action has no specific policy coverage and the gate will deny it."
        )
        return 1

    # The failure this design exists to prevent: a governing rule that only
    # similarity would have found, i.e. one that a top-k system could miss.
    deterministic_only = [
        c for c in result.chunks
        if c.via in ("mandatory", "action") and c.score is None
    ]
    print(
        f"\n{len(deterministic_only)} rule(s) were retrieved by filter alone. "
        f"A similarity-only retriever would have had to rank each of them into the "
        f"top {settings.POLICY_TOP_K} to see them."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

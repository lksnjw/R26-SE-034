"""Checks for evaluation scoring and failure accounting; no model calls."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("evaluate_model", Path(__file__).resolve().parents[1] / "evaluate_model.py")
evaluation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(evaluation)


class EvaluationTests(unittest.TestCase):
    def test_format_requires_ordered_nonempty_sections(self):
        self.assertTrue(evaluation.whw_format("**WHAT:** Post journal.\n**HOW:** Simulate first.\n**WHY:** Accuracy."))
        self.assertFalse(evaluation.whw_format("WHAT:\nHOW: Simulate.\nWHY: Accuracy."))
        self.assertFalse(evaluation.whw_format("WHY: Accuracy.\nWHAT: Post.\nHOW: Simulate."))

    def test_refusal_and_scope_labels(self):
        self.assertTrue(evaluation.expected_refusal("ACTION BLOCKED: Outside ERP scope."))
        self.assertTrue(evaluation.refusal_proxy("I can only assist with ERP processes."))
        self.assertFalse(evaluation.refusal_proxy("WHAT: Post an ERP journal.\nHOW: Use FB50.\nWHY: Accuracy."))

    def test_failures_stay_in_denominators(self):
        base = dict(status="ok", expected_refusal=False, whw_format=True, refusal_proxy=False,
                    done_reason="stop", rouge1=.8, rouge2=.6, rougeL=.7,
                    standard_agreement=True, strict_agreement=True, latency_seconds=2,
                    tokens_per_second=3)
        failed = dict(base, status="error", whw_format=False, rouge1=0, rouge2=0, rougeL=0,
                      standard_agreement=False, strict_agreement=False, tokens_per_second=None)
        refused = dict(base, expected_refusal=True, refusal_proxy=True)
        summary = evaluation.summarize([base, failed, refused], 4)
        self.assertEqual(summary["status"], "partial")
        self.assertEqual(summary["errors"], 1)
        self.assertEqual(summary["in_scope_whw_format_rate"], .5)
        self.assertEqual(summary["in_scope_rouge"]["rougeL"], .35)
        self.assertEqual(summary["out_of_scope_refusal_proxy_rate"], 1)
        self.assertEqual(summary["response_scope_proxy_matrix"]["IN_SCOPE"]["ERROR"], 1)

    def test_reference_benchmark_composition(self):
        rows = evaluation.load_dataset(evaluation.ROOT / "Data" / "erp_eval_realistic_50.jsonl")
        self.assertEqual(len(rows), 50)
        self.assertEqual(sum(evaluation.expected_refusal(r["assistant"]) for r in rows), 10)
        self.assertEqual(len({evaluation.normalize(r["user"]) for r in rows}), 50)


if __name__ == "__main__":
    unittest.main()

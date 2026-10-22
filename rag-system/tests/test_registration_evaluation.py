"""Offline checks of benchmark accounting, not a substitute for live evaluation."""
import unittest
from datetime import date

from scripts.eval_registration import metrics, validate_cases, wilson
from scripts.registration_benchmark import build_cases


def observation(expected, predicted, expected_policies=(), policies=()):
    return dict(expected=expected, predicted=predicted, expected_failed_policies=list(expected_policies),
                failed_policies=list(policies), expected_failed_fields=[], failed_fields=[],
                latency_seconds=1, passed=expected == predicted)


class EvaluationTests(unittest.TestCase):
    def test_errors_remain_in_denominator(self):
        result = metrics([observation("ALLOW", "ALLOW"), observation("ALLOW", "ERROR"),
                          observation("BLOCK", "ALLOW"), observation("ESCALATE", "ESCALATE")])
        self.assertEqual(result["accuracy"], .5)
        self.assertEqual(result["errors"], 1)
        self.assertEqual(result["unsafe_allow"], {"numerator": 1, "denominator": 2, "rate": .5})
        self.assertEqual(result["confusion_matrix"]["ALLOW"]["ERROR"], 1)
        self.assertAlmostEqual(result["macro_f1"], .5)

    def test_wrong_extra_policy_is_penalized(self):
        result = metrics([observation("BLOCK", "BLOCK", ["EMP-REG-004"], ["EMP-REG-004", "EMP-REG-005"])])
        self.assertEqual(result["failed_policies"]["precision_micro"], .5)
        self.assertEqual(result["failed_policies"]["recall_micro"], 1)
        self.assertEqual(result["failed_policies"]["exact_match"], 0)

    def test_no_unsafe_denominator_is_not_zero_risk(self):
        self.assertIsNone(metrics([observation("ALLOW", "ALLOW")])["unsafe_allow"]["rate"])
        self.assertIsNone(wilson(0, 0))
        self.assertGreater(wilson(0, 100)[1], 0)

    def test_dataset_is_valid_and_deterministic(self):
        cases = build_cases(date(2026, 10, 19))
        validate_cases(cases)
        self.assertEqual(cases, build_cases(date(2026, 10, 19)))
        self.assertGreater(len(cases), 100)
        self.assertEqual({c["expected_verdict"] for c in cases}, {"ALLOW", "BLOCK", "ESCALATE"})
        self.assertTrue(all("SYNTHETIC" in c["request"]["duplicate_check"]["reference"]
            for c in cases if c["request"]["duplicate_check"] and c["request"]["duplicate_check"]["reference"]))

    def test_duplicate_ids_rejected(self):
        case = build_cases(date(2026, 10, 19))[0]
        with self.assertRaises(ValueError):
            validate_cases([case, case])

    def test_missing_negative_labels_rejected(self):
        case = build_cases(date(2026, 10, 19))[0]
        case["expected_failed_fields"] = ["phone"]
        with self.assertRaises(ValueError):
            validate_cases([case])


if __name__ == "__main__":
    unittest.main()

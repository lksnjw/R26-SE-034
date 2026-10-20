import unittest

from scripts.eval_record_policies import build_probes, summarize


class RecordEvaluationTests(unittest.TestCase):
    def test_semantic_ranking_and_filter_errors_are_separate(self):
        rows = [
            dict(case_id="a", expected_policy_id="P", semantic_hit_at_1=True,
                 semantic_recall_at_3=True, reciprocal_rank=1, filtered_match=False,
                 errors={"filtered": "UnexpectedResponse"}, passed=False),
            dict(case_id="b", expected_policy_id="P", semantic_hit_at_1=False,
                 semantic_recall_at_3=True, reciprocal_rank=.5, filtered_match=True,
                 errors={}, passed=False),
        ]
        result = summarize(rows)
        self.assertEqual(result["semantic_hit_at_1"], .5)
        self.assertEqual(result["semantic_mrr"], .75)
        self.assertEqual(result["filtered_expected_policy_recall"], .5)
        self.assertEqual(result["error_observations"], 1)
        self.assertIsNone(result["decision_accuracy"])

    def test_error_on_unsupported_action_is_not_successful_isolation(self):
        result = summarize([dict(case_id="unknown", expected_policy_id=None,
            filtered_match=False, errors={"filtered": "UnexpectedResponse"}, passed=False)])
        self.assertEqual(result["unsupported_action_isolation"], 0)
        self.assertIsNone(result["semantic_hit_at_1"])
        self.assertIsNone(result["semantic_mrr"])

    def test_fixture_scope_and_unique_ids(self):
        probes = build_probes()
        self.assertEqual(len(probes), 32)
        self.assertEqual(len({p["case_id"] for p in probes}), 32)
        self.assertEqual(sum(p["expected_policy_id"] is None for p in probes), 2)
        self.assertEqual(len({p["expected_policy_id"] for p in probes if p["expected_policy_id"]}), 3)


if __name__ == "__main__":
    unittest.main()

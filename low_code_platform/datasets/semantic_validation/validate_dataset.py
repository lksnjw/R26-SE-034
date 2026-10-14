import json
import sys
from collections import Counter, defaultdict
from pathlib import Path


REQUIRED_FIELDS = [
    "id",
    "domain",
    "complexity",
    "user_role",
    "instruction",
    "output",
    "category",
    "expected_result",
    "block_reason",
    "violated_rule_id",
    "self_healing_hint",
    "step_count",
    "has_variable_injection",
    "has_conditional",
    "has_approval_gate",
    "ground_truth_notes",
]

VALID_CATEGORIES = ["perfect", "missing_parameters", "unauthorized_action", "hallucinated_action", "rbac_violation"]
VALID_DOMAINS = ["hr", "finance", "inventory", "crm", "it_operations"]
VALID_ROLES = ["hr_manager", "finance_manager", "warehouse_staff", "sales_rep", "it_admin", "department_head", "ceo", "intern"]
VALID_COMPLEXITY = ["simple", "medium", "complex"]
EXPECTED_CATEGORY_COUNTS = {
    "perfect": 3000,
    "missing_parameters": 500,
    "unauthorized_action": 500,
    "hallucinated_action": 500,
    "rbac_violation": 500,
}
EXPECTED_COMPLEXITY_COUNTS = {"simple": 1500, "medium": 2000, "complex": 1500}
EXPECTED_DOMAIN_COUNTS = {domain: 1000 for domain in VALID_DOMAINS}


def validate_file(filepath):
    filepath = Path(filepath)
    errors = []
    stats = defaultdict(Counter)
    seen_ids = set()
    total = 0

    with filepath.open("r", encoding="utf-8") as file:
        for line_num, line in enumerate(file, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                total += 1
            except json.JSONDecodeError as exc:
                errors.append(f"Line {line_num}: INVALID JSON - {exc}")
                continue

            for field in REQUIRED_FIELDS:
                if field not in obj:
                    errors.append(f"Line {line_num} [{obj.get('id', '?')}]: Missing field {field}")

            example_id = obj.get("id")
            if example_id in seen_ids:
                errors.append(f"Line {line_num}: duplicate id {example_id}")
            seen_ids.add(example_id)

            if obj.get("domain") not in VALID_DOMAINS:
                errors.append(f"Line {line_num}: Invalid domain {obj.get('domain')}")
            if obj.get("user_role") not in VALID_ROLES:
                errors.append(f"Line {line_num}: Invalid user_role {obj.get('user_role')}")
            if obj.get("complexity") not in VALID_COMPLEXITY:
                errors.append(f"Line {line_num}: Invalid complexity {obj.get('complexity')}")
            if obj.get("category") not in VALID_CATEGORIES:
                errors.append(f"Line {line_num}: Invalid category {obj.get('category')}")
            if obj.get("expected_result") not in ["PASS", "BLOCK"]:
                errors.append(f"Line {line_num}: expected_result must be PASS or BLOCK")

            if obj.get("expected_result") == "PASS":
                if obj.get("block_reason") is not None:
                    errors.append(f"Line {line_num}: PASS should have null block_reason")
                if obj.get("violated_rule_id") is not None:
                    errors.append(f"Line {line_num}: PASS should have null violated_rule_id")
                if obj.get("self_healing_hint") is not None:
                    errors.append(f"Line {line_num}: PASS should have null self_healing_hint")
            if obj.get("expected_result") == "BLOCK":
                if obj.get("block_reason") is None:
                    errors.append(f"Line {line_num}: BLOCK needs non-null block_reason")
                if obj.get("violated_rule_id") is None:
                    errors.append(f"Line {line_num}: BLOCK needs non-null violated_rule_id")
                if obj.get("self_healing_hint") is None:
                    errors.append(f"Line {line_num}: BLOCK needs non-null self_healing_hint")

            output = obj.get("output", "")
            actual_steps = output.count("  - step_id:")
            if actual_steps != obj.get("step_count"):
                errors.append(f"Line {line_num}: step_count {obj.get('step_count')} does not match YAML steps {actual_steps}")
            if ("{{step_" in output) != obj.get("has_variable_injection"):
                errors.append(f"Line {line_num}: has_variable_injection flag mismatch")
            if ("action: check_condition" in output) != obj.get("has_conditional"):
                errors.append(f"Line {line_num}: has_conditional flag mismatch")
            if ("action: request_human_approval" in output) != obj.get("has_approval_gate"):
                errors.append(f"Line {line_num}: has_approval_gate flag mismatch")

            stats["category"][obj.get("category")] += 1
            stats["domain"][obj.get("domain")] += 1
            stats["complexity"][obj.get("complexity")] += 1

    if total != 5000 and filepath.name == "dataset_full_5000.jsonl":
        errors.append(f"Expected 5000 examples, found {total}")

    for name, expected_counts in [
        ("category", EXPECTED_CATEGORY_COUNTS),
        ("complexity", EXPECTED_COMPLEXITY_COUNTS),
        ("domain", EXPECTED_DOMAIN_COUNTS),
    ]:
        if filepath.name == "dataset_full_5000.jsonl":
            for key, expected in expected_counts.items():
                actual = stats[name][key]
                if actual != expected:
                    errors.append(f"{name} count for {key} expected {expected}, found {actual}")

    print("=" * 58)
    print("DATASET VALIDATION REPORT")
    print("=" * 58)
    print(f"File: {filepath}")
    print(f"Total examples: {total}")
    print("\nCategory distribution:")
    for category in VALID_CATEGORIES:
        print(f"  {category:<25} {stats['category'][category]:>5}")
    print("\nDomain distribution:")
    for domain in VALID_DOMAINS:
        print(f"  {domain:<20} {stats['domain'][domain]:>5}")
    print("\nComplexity distribution:")
    for complexity in VALID_COMPLEXITY:
        print(f"  {complexity:<10} {stats['complexity'][complexity]:>5}")
    print(f"\nErrors found: {len(errors)}")
    if errors:
        print("\nFIRST 20 ERRORS:")
        for error in errors[:20]:
            print(f"  {error}")
    else:
        print("  No errors - dataset is valid.")
    print("=" * 58)
    return errors


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "dataset_full_5000.jsonl"
    sys.exit(1 if validate_file(target) else 0)

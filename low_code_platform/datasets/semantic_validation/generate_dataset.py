import csv
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parent
FIELDS = [
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

DOMAINS = ["hr", "finance", "inventory", "crm", "it_operations"]

DOMAIN_CONFIG = {
    "hr": {
        "role": "hr_manager",
        "table": "employees",
        "alt_table": "leave_requests",
        "report": "monthly_attendance",
        "subject": "HR workflow update",
        "thing": "employee profile",
        "record_id": "EMP",
        "filters": {"department": "Operations", "status": "active"},
    },
    "finance": {
        "role": "finance_manager",
        "table": "invoices",
        "alt_table": "expenses",
        "report": "monthly_financial_summary",
        "subject": "Finance workflow update",
        "thing": "invoice",
        "record_id": "INV",
        "filters": {"period": "Q3_2026", "status": "pending"},
    },
    "inventory": {
        "role": "warehouse_staff",
        "table": "inventory",
        "alt_table": "stock_levels",
        "report": "stock_movement",
        "subject": "Inventory workflow update",
        "thing": "stock item",
        "record_id": "SKU",
        "filters": {"warehouse": "main", "stock_status": "below_threshold"},
    },
    "crm": {
        "role": "sales_rep",
        "table": "customers",
        "alt_table": "quotes",
        "report": "lead_followup",
        "subject": "CRM workflow update",
        "thing": "customer account",
        "record_id": "CUST",
        "filters": {"segment": "enterprise", "status": "open"},
    },
    "it_operations": {
        "role": "it_admin",
        "table": "user_accounts",
        "alt_table": "system_logs",
        "report": "incident_summary",
        "subject": "IT operations workflow update",
        "thing": "system access record",
        "record_id": "USR",
        "filters": {"service": "erp", "severity": "warning"},
    },
}

INSTRUCTION_PREFIXES = [
    "Can you",
    "Please",
    "I need to",
    "Set up a workflow to",
    "Mata puluwanda",
    "Kindly",
    "Check and",
    "Generate a workflow to",
]


def yaml_scalar(value):
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if value is None:
        return "null"
    text = str(value)
    if text.startswith("{{") or any(ch in text for ch in [":", "#", "{", "}", "[", "]"]):
        return f'"{text}"'
    return text


def render_parameters(parameters, indent="      "):
    lines = []
    for key, value in parameters.items():
        if isinstance(value, dict):
            lines.append(f"{indent}{key}:")
            for nested_key, nested_value in value.items():
                lines.append(f"{indent}  {nested_key}: {yaml_scalar(nested_value)}")
        else:
            lines.append(f"{indent}{key}: {yaml_scalar(value)}")
    return "\n".join(lines)


def render_workflow(name, description, role, steps, risk="low", approval=False, max_ms=1000):
    lines = [
        f"workflow_name: {name}",
        f"description: {description}",
        'version: "1.0"',
        f"created_by_role: {role}",
        "steps:",
    ]
    for step in steps:
        lines.append(f"  - step_id: {step['step_id']}")
        lines.append(f"    action: {step['action']}")
        lines.append(f"    description: {step['description']}")
        lines.append("    parameters:")
        params = step.get("parameters", {})
        if params:
            lines.append(render_parameters(params))
        else:
            lines.append("      {}")
        if step.get("depends_on"):
            lines.append(f"    depends_on: {step['depends_on']}")
        lines.append(f"    on_failure: {step.get('on_failure', 'retry_once')}")
    lines.extend(
        [
            "validation:",
            f"  rbac_required_role: {role}",
            f"  estimated_risk_level: {risk}",
            f"  requires_human_approval: {yaml_scalar(approval)}",
            f"  max_execution_time_ms: {max_ms}",
        ]
    )
    return "\n".join(lines)


def category_for(example_number):
    if example_number <= 30:
        return "perfect"
    if example_number <= 35:
        return "missing_parameters"
    if example_number <= 40:
        return "unauthorized_action"
    if example_number <= 45:
        return "hallucinated_action"
    return "rbac_violation"


def complexity_for(example_number):
    if example_number <= 15:
        return "simple"
    if example_number <= 35:
        return "medium"
    return "complex"


def domain_for(batch_number, example_number):
    return DOMAINS[(batch_number + example_number - 2) % len(DOMAINS)]


def suffix(batch_number, example_number):
    return f"{batch_number:03d}{example_number:03d}"


def instruction(prefix_index, domain, complexity, category, cfg, batch_number, example_number):
    prefix = INSTRUCTION_PREFIXES[prefix_index % len(INSTRUCTION_PREFIXES)]
    code = suffix(batch_number, example_number)
    if category == "perfect" and complexity == "simple":
        return f"{prefix} check the current {cfg['thing']} details for reference {cfg['record_id']}_{code}"
    if category == "perfect" and complexity == "medium":
        return f"{prefix} find pending {domain} records, calculate the total amount, and email the manager if it is over the review limit"
    if category == "perfect":
        return f"{prefix} review the {domain} case {cfg['record_id']}_{code}, calculate the total, request approval, update the record, and notify the owner"
    if category == "missing_parameters":
        return f"{prefix} process this {domain} update quickly, but the staff member gave incomplete details"
    if category == "unauthorized_action":
        return f"{prefix} permanently delete the old {domain} record {cfg['record_id']}_{code} from the system"
    if category == "hallucinated_action":
        return f"{prefix} automatically fix the whole {domain} issue using AI without manual checking"
    return f"{prefix} handle a restricted {domain} task even though my role may not normally have access"


def perfect_steps(domain, complexity, cfg, batch_number, example_number):
    code = suffix(batch_number, example_number)
    if complexity == "simple":
        return [
            {
                "step_id": "step_1",
                "action": "fetch_record",
                "description": f"Fetch {domain} records for the requested business reference",
                "parameters": {"table": cfg["table"], "filters": {"reference_id": f"{cfg['record_id']}_{code}"}},
            }
        ], "low", False

    if complexity == "medium":
        return [
            {
                "step_id": "step_1",
                "action": "fetch_record",
                "description": f"Retrieve pending {domain} records for review",
                "parameters": {"table": cfg["alt_table"], "filters": cfg["filters"]},
            },
            {
                "step_id": "step_2",
                "action": "calculate_sum",
                "description": "Calculate the total amount from fetched records",
                "parameters": {"source_step": "step_1", "field_name": "amount"},
                "depends_on": "step_1",
                "on_failure": "escalate_to_human",
            },
            {
                "step_id": "step_3",
                "action": "check_condition",
                "description": "Check whether the total amount requires manager notification",
                "parameters": {"condition": "{{step_2.total}} > 50000"},
                "depends_on": "step_2",
            },
            {
                "step_id": "step_4",
                "action": "send_email_notification",
                "description": "Notify responsible manager with the calculated total",
                "parameters": {
                    "recipient_role": cfg["role"],
                    "subject": cfg["subject"],
                    "body": "Total is {{step_2.total}} LKR and condition result is {{step_3.result}}.",
                },
                "depends_on": "step_3",
            },
        ], "medium", False

    return [
        {
            "step_id": "step_1",
            "action": "fetch_record",
            "description": f"Fetch the source {domain} case data",
            "parameters": {"table": cfg["table"], "filters": {"reference_id": f"{cfg['record_id']}_{code}"}},
        },
        {
            "step_id": "step_2",
            "action": "calculate_sum",
            "description": "Calculate the total impact amount",
            "parameters": {"source_step": "step_1", "field_name": "amount"},
            "depends_on": "step_1",
            "on_failure": "escalate_to_human",
        },
        {
            "step_id": "step_3",
            "action": "check_condition",
            "description": "Check if approval is required for this case",
            "parameters": {"condition": "{{step_2.total}} > 75000"},
            "depends_on": "step_2",
        },
        {
            "step_id": "step_4",
            "action": "request_human_approval",
            "description": "Request approval from the responsible business owner",
            "parameters": {
                "approver_role": "department_head",
                "context": "Workflow total is {{step_2.total}} LKR and requires review.",
                "priority": "high",
            },
            "depends_on": "step_3",
            "on_failure": "escalate_to_human",
        },
        {
            "step_id": "step_5",
            "action": "update_record",
            "description": "Update the case after approval is captured",
            "parameters": {
                "table": cfg["table"],
                "record_id": f"{cfg['record_id']}_{code}",
                "data": {"status": "approved_after_review", "approval_ref": "{{step_4.approval_id}}"},
            },
            "depends_on": "step_4",
            "on_failure": "escalate_to_human",
        },
        {
            "step_id": "step_6",
            "action": "send_email_notification",
            "description": "Notify the owner that the workflow completed",
            "parameters": {
                "recipient_role": cfg["role"],
                "subject": cfg["subject"],
                "body": "Workflow completed for approval {{step_4.approval_id}}.",
            },
            "depends_on": "step_5",
        },
    ], "high", True


def missing_parameter_case(example_number, cfg, code):
    variant = (example_number - 31) % 5
    if variant == 0:
        return (
            [
                {
                    "step_id": "step_1",
                    "action": "create_record",
                    "description": "Create a new record but omit the table parameter",
                    "parameters": {"data": {"reference_id": f"{cfg['record_id']}_{code}", "status": "draft"}},
                },
                {
                    "step_id": "step_2",
                    "action": "send_email_notification",
                    "description": "Notify owner after attempted creation",
                    "parameters": {
                        "recipient_role": cfg["role"],
                        "subject": "Incomplete workflow attempted",
                        "body": "Creation attempted for {{step_1.record_id}}.",
                    },
                    "depends_on": "step_1",
                },
                {
                    "step_id": "step_3",
                    "action": "check_condition",
                    "description": "Check whether creation returned a record",
                    "parameters": {"condition": "{{step_1.record_id}} != null"},
                    "depends_on": "step_2",
                },
            ],
            "RULE_002",
            "create_record requires the missing table parameter.",
        )
    if variant == 1:
        return (
            [
                {
                    "step_id": "step_1",
                    "action": "create_record",
                    "description": "Create a record but omit required data object",
                    "parameters": {"table": cfg["table"]},
                },
                {
                    "step_id": "step_2",
                    "action": "send_email_notification",
                    "description": "Notify owner about incomplete create request",
                    "parameters": {
                        "recipient_role": cfg["role"],
                        "subject": "Create request needs data",
                        "body": "The create request did not include a data object.",
                    },
                    "depends_on": "step_1",
                },
                {
                    "step_id": "step_3",
                    "action": "check_condition",
                    "description": "Check the incomplete create response",
                    "parameters": {"condition": "{{step_1.status}} == created"},
                    "depends_on": "step_2",
                },
            ],
            "RULE_003",
            "create_record requires a data object.",
        )
    if variant == 2:
        return (
            [
                {
                    "step_id": "step_1",
                    "action": "fetch_record",
                    "description": "Fetch records before update",
                    "parameters": {"table": cfg["table"], "filters": cfg["filters"]},
                },
                {
                    "step_id": "step_2",
                    "action": "update_record",
                    "description": "Update record but omit record_id",
                    "parameters": {"table": cfg["table"], "data": {"status": "reviewed"}},
                    "depends_on": "step_1",
                    "on_failure": "escalate_to_human",
                },
                {
                    "step_id": "step_3",
                    "action": "send_email_notification",
                    "description": "Notify owner after incomplete update",
                    "parameters": {"recipient_role": cfg["role"], "subject": "Update attempted", "body": "Update result is {{step_2.status}}."},
                    "depends_on": "step_2",
                },
            ],
            "RULE_004",
            "update_record requires record_id.",
        )
    if variant == 3:
        return (
            [
                {
                    "step_id": "step_1",
                    "action": "fetch_record",
                    "description": "Fetch candidate record",
                    "parameters": {"table": cfg["table"], "filters": cfg["filters"]},
                },
                {
                    "step_id": "step_2",
                    "action": "update_record",
                    "description": "Update record but omit table",
                    "parameters": {"record_id": f"{cfg['record_id']}_{code}", "data": {"status": "updated"}},
                    "depends_on": "step_1",
                },
                {
                    "step_id": "step_3",
                    "action": "check_condition",
                    "description": "Check update output",
                    "parameters": {"condition": "{{step_2.updated}} == true"},
                    "depends_on": "step_2",
                },
            ],
            "RULE_005",
            "update_record requires table.",
        )
    return (
        [
            {
                "step_id": "step_1",
                "action": "fetch_record",
                "description": "Fetch old record before archive",
                "parameters": {"table": cfg["table"], "filters": {"record_id": f"{cfg['record_id']}_{code}"}},
            },
            {
                "step_id": "step_2",
                "action": "archive_record",
                "description": "Archive record but omit required reason",
                "parameters": {"table": cfg["table"], "record_id": f"{cfg['record_id']}_{code}"},
                "depends_on": "step_1",
            },
            {
                "step_id": "step_3",
                "action": "send_email_notification",
                "description": "Notify owner about attempted archive",
                "parameters": {"recipient_role": cfg["role"], "subject": "Archive attempted", "body": "Archive result is {{step_2.status}}."},
                "depends_on": "step_2",
            },
        ],
        "RULE_006",
        "archive_record requires reason.",
    )


def invalid_complex_tail(cfg):
    return [
        {
            "step_id": "step_2",
            "action": "calculate_sum",
            "description": "Calculate impact amount from fetched data",
            "parameters": {"source_step": "step_1", "field_name": "amount"},
            "depends_on": "step_1",
        },
        {
            "step_id": "step_3",
            "action": "check_condition",
            "description": "Check if the workflow is above the review threshold",
            "parameters": {"condition": "{{step_2.total}} > 100000"},
            "depends_on": "step_2",
        },
        {
            "step_id": "step_4",
            "action": "request_human_approval",
            "description": "Request manual approval before final notification",
            "parameters": {"approver_role": "department_head", "context": "Total impact is {{step_2.total}} LKR.", "priority": "high"},
            "depends_on": "step_3",
            "on_failure": "escalate_to_human",
        },
        {
            "step_id": "step_5",
            "action": "send_email_notification",
            "description": "Notify responsible owner",
            "parameters": {"recipient_role": cfg["role"], "subject": cfg["subject"], "body": "Workflow completed with approval {{step_4.approval_id}}."},
            "depends_on": "step_4",
        },
    ]


def unauthorized_steps(cfg, code):
    return [
        {
            "step_id": "step_1",
            "action": "delete_record",
            "description": "Attempt to permanently delete a business record",
            "parameters": {"table": cfg["table"], "record_id": f"{cfg['record_id']}_{code}"},
        }
    ] + invalid_complex_tail(cfg)


def hallucinated_steps(example_number, cfg, code):
    actions = [
        "ai_auto_fix_discrepancies",
        "smart_sync_erp_records",
        "predict_and_apply_budget",
        "auto_negotiate_supplier_terms",
        "generate_magic_compliance_patch",
    ]
    action = actions[(example_number - 41) % len(actions)]
    return [
        {
            "step_id": "step_1",
            "action": action,
            "description": "Use a non-existent autonomous action invented by the model",
            "parameters": {"table": cfg["table"], "record_id": f"{cfg['record_id']}_{code}", "mode": "automatic"},
        }
    ] + invalid_complex_tail(cfg)


def rbac_case(example_number, code):
    variant = (example_number - 46) % 5
    if variant == 0:
        cfg = DOMAIN_CONFIG["crm"]
        return "intern", cfg, [
            {"step_id": "step_1", "action": "create_record", "description": "Intern attempts to create customer record", "parameters": {"table": "customers", "data": {"customer_name": f"Training Customer {code}", "status": "new"}}}
        ] + invalid_complex_tail(cfg), "RULE_008", "rbac_role_violation", "intern cannot create_record or update_record."
    if variant == 1:
        cfg = DOMAIN_CONFIG["hr"]
        return "warehouse_staff", cfg, [
            {"step_id": "step_1", "action": "update_record", "description": "Warehouse staff attempts to update payroll", "parameters": {"table": "payroll", "record_id": f"PAY_{code}", "data": {"salary": 120000}}}
        ] + invalid_complex_tail(cfg), "RULE_009", "rbac_role_violation", "warehouse_staff cannot access payroll or hr tables."
    if variant == 2:
        cfg = DOMAIN_CONFIG["finance"]
        return "sales_rep", cfg, [
            {"step_id": "step_1", "action": "archive_record", "description": "Sales rep attempts to archive a finance record", "parameters": {"table": "finance_invoices", "record_id": f"FIN_{code}", "reason": "Requested by sales team"}}
        ] + invalid_complex_tail(cfg), "RULE_010", "rbac_role_violation", "sales_rep cannot access finance or payroll tables."
    if variant == 3:
        cfg = DOMAIN_CONFIG["finance"]
        return "finance_manager", cfg, [
            {"step_id": "step_1", "action": "create_record", "description": "Finance manager attempts payment above financial limit", "parameters": {"table": "expenses", "data": {"vendor": "Sigma Supplies", "amount": 1500000, "currency": "LKR"}}}
        ] + invalid_complex_tail(cfg), "RULE_012", "financial_limit_exceeded", "amount exceeds finance_manager limit and requires CEO escalation."
    cfg = DOMAIN_CONFIG["finance"]
    return "it_admin", cfg, [
        {"step_id": "step_1", "action": "fetch_record", "description": "IT admin attempts to access finance table", "parameters": {"table": "finance_reports", "filters": {"period": "Q4_2026"}}}
    ] + invalid_complex_tail(cfg), "RULE_018", "rbac_role_violation", "finance table access is restricted to finance roles and CEO."


def build_example(batch_number, example_number):
    category = category_for(example_number)
    complexity = complexity_for(example_number)
    domain = domain_for(batch_number, example_number)
    cfg = DOMAIN_CONFIG[domain]
    code = suffix(batch_number, example_number)
    prefix_index = batch_number + example_number

    role = cfg["role"]
    block_reason = None
    rule_id = None
    healing_hint = None
    risk = "low"
    approval = False

    if category == "perfect":
        steps, risk, approval = perfect_steps(domain, complexity, cfg, batch_number, example_number)
        workflow_name = f"{domain}_{complexity}_workflow_{code}"
        description = f"Valid {domain} workflow generated for semantic validator pass testing"
        notes = f"Valid {complexity} {domain} workflow; all actions and tables are permitted for {role}."
        expected = "PASS"
    elif category == "missing_parameters":
        steps, rule_id, note = missing_parameter_case(example_number, cfg, code)
        workflow_name = f"{domain}_missing_parameter_{code}"
        description = f"Invalid {domain} workflow with a missing required parameter"
        expected = "BLOCK"
        block_reason = "missing_required_parameter"
        healing_hint = f"Re-prompt LLM with validator error: {note} Add the missing field to the failing step parameters."
        notes = f"{note} Validator should block with {rule_id}."
        risk = "medium"
    elif category == "unauthorized_action":
        steps = unauthorized_steps(cfg, code)
        workflow_name = f"{domain}_delete_attempt_{code}"
        description = f"Invalid {domain} workflow that uses prohibited delete_record action"
        expected = "BLOCK"
        block_reason = "unauthorized_destructive_action"
        rule_id = "RULE_001"
        healing_hint = "Replace delete_record with archive_record, add a reason parameter, and keep human approval for destructive intent."
        notes = "delete_record is prohibited and must be blocked by RULE_001."
        risk = "high"
        approval = True
    elif category == "hallucinated_action":
        steps = hallucinated_steps(example_number, cfg, code)
        workflow_name = f"{domain}_hallucinated_action_{code}"
        description = f"Invalid {domain} workflow containing an action outside the registry"
        expected = "BLOCK"
        block_reason = "action_not_in_registry"
        rule_id = "RULE_007"
        healing_hint = "Replace the hallucinated action with valid registry actions such as fetch_record, check_condition, request_human_approval, and send_email_notification."
        notes = "The first step action is not in the 9-action registry and must be blocked by RULE_007."
        risk = "medium"
    else:
        role, cfg, steps, rule_id, block_reason, note = rbac_case(example_number, code)
        domain = domain_for(batch_number, example_number)
        workflow_name = f"{domain}_rbac_violation_{code}"
        description = f"Invalid {domain} workflow designed to trigger RBAC validation"
        expected = "BLOCK"
        healing_hint = f"Return permission denied or escalate to an authorized role because {note}"
        notes = f"{note} Validator should block with {rule_id}."
        risk = "high"
        approval = True

    output = render_workflow(
        workflow_name,
        description,
        role,
        steps,
        risk=risk,
        approval=approval,
        max_ms=500 if complexity == "simple" else 3000 if complexity == "medium" else 7000,
    )

    return {
        "id": f"{batch_number:03d}_{example_number:03d}",
        "domain": domain,
        "complexity": complexity,
        "user_role": role,
        "instruction": instruction(prefix_index, domain, complexity, category, cfg, batch_number, example_number),
        "output": output,
        "category": category,
        "expected_result": expected,
        "block_reason": block_reason,
        "violated_rule_id": rule_id,
        "self_healing_hint": healing_hint,
        "step_count": len(steps),
        "has_variable_injection": "{{step_" in output,
        "has_conditional": "action: check_condition" in output,
        "has_approval_gate": "action: request_human_approval" in output,
        "ground_truth_notes": notes,
    }


def write_jsonl(path, rows):
    with path.open("w", encoding="utf-8", newline="\n") as file:
        for row in rows:
            file.write(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n")


def write_csv(path, rows):
    with path.open("w", encoding="utf-8", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def write_json(path, rows):
    with path.open("w", encoding="utf-8") as file:
        json.dump(rows, file, ensure_ascii=False, indent=2)


def main():
    all_rows = []
    for batch_number in range(1, 101):
        batch_rows = [build_example(batch_number, example_number) for example_number in range(1, 51)]
        write_jsonl(ROOT / f"batch_{batch_number:03d}.jsonl", batch_rows)
        all_rows.extend(batch_rows)

    write_jsonl(ROOT / "dataset_full_5000.jsonl", all_rows)
    write_json(ROOT / "dataset_full_5000.json", all_rows)
    write_csv(ROOT / "dataset_full_5000.csv", all_rows)
    print(f"generated {len(all_rows)} examples")


if __name__ == "__main__":
    main()

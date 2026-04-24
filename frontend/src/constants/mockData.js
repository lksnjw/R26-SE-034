import { WORKFLOW_STATUS } from "./workflowStatus";

export const dashboardMetrics = [
  {
    label: "Active Workflows",
    value: "42",
    delta: "+12.5%",
    icon: "tabler:git-branch",
    tone: "primary",
  },
  {
    label: "Successful Runs",
    value: "98.4%",
    delta: "+2.1%",
    icon: "mdi:check-decagram-outline",
    tone: "green",
  },
  {
    label: "Avg Latency",
    value: "1.8s",
    delta: "-320ms",
    icon: "mdi:timer-outline",
    tone: "blue",
  },
  {
    label: "Healing Wins",
    value: "17",
    delta: "+5 today",
    icon: "mdi:shield-refresh-outline",
    tone: "purple",
  },
];

export const workflows = [
  {
    id: "wf-101",
    name: "ERP Invoice Exception Resolver",
    owner: "Ops Automation",
    status: WORKFLOW_STATUS.RUNNING,
    trigger: "New invoice anomaly",
    steps: 7,
    successRate: "97.8%",
    lastRun: "2 min ago",
    description:
      "Detects mismatched supplier invoices, asks the LLM to classify the root cause, and routes approvals.",
  },
  {
    id: "wf-102",
    name: "Procurement Risk Escalation",
    owner: "Supply Chain",
    status: WORKFLOW_STATUS.HEALING,
    trigger: "Vendor risk score",
    steps: 6,
    successRate: "94.2%",
    lastRun: "8 min ago",
    description:
      "Scores supplier events, generates mitigation notes, and escalates risky decisions to human reviewers.",
  },
  {
    id: "wf-103",
    name: "Customer Refund Auto-Triage",
    owner: "CX",
    status: WORKFLOW_STATUS.DONE,
    trigger: "Support ticket created",
    steps: 5,
    successRate: "99.1%",
    lastRun: "18 min ago",
    description:
      "Classifies refund requests, verifies policy constraints, and drafts a next action for the agent.",
  },
  {
    id: "wf-104",
    name: "Inventory Reorder Planner",
    owner: "Warehouse",
    status: WORKFLOW_STATUS.PENDING,
    trigger: "Stock below threshold",
    steps: 8,
    successRate: "92.6%",
    lastRun: "1 hour ago",
    description:
      "Combines demand signals, ERP inventory, and approval rules to recommend safe reorder quantities.",
  },
];

export const workflowNodes = [
  {
    id: "trigger",
    label: "ERP Event Trigger",
    type: "Trigger",
    icon: "mdi:flash-outline",
    x: 70,
    y: 72,
    status: WORKFLOW_STATUS.DONE,
  },
  {
    id: "classify",
    label: "Classify Intent",
    type: "LLM Action",
    icon: "hugeicons:ai-magic",
    x: 330,
    y: 72,
    status: WORKFLOW_STATUS.DONE,
  },
  {
    id: "policy",
    label: "Policy Guardrail",
    type: "Condition",
    icon: "mdi:source-branch",
    x: 595,
    y: 72,
    status: WORKFLOW_STATUS.RUNNING,
  },
  {
    id: "repair",
    label: "Self-Heal Retry",
    type: "Healing",
    icon: "mdi:shield-refresh-outline",
    x: 595,
    y: 245,
    status: WORKFLOW_STATUS.HEALING,
  },
  {
    id: "notify",
    label: "Notify Owner",
    type: "Action",
    icon: "mdi:bell-outline",
    x: 850,
    y: 72,
    status: WORKFLOW_STATUS.PENDING,
  },
];

export const activityItems = [
  {
    title: "Procurement Risk Escalation entered self-healing",
    meta: "8 minutes ago",
    icon: "mdi:shield-refresh-outline",
    tone: "purple",
  },
  {
    title: "ERP Invoice Exception Resolver completed 24 runs",
    meta: "22 minutes ago",
    icon: "mdi:check-decagram-outline",
    tone: "green",
  },
  {
    title: "New MCP connector added for ERP sandbox",
    meta: "1 hour ago",
    icon: "mdi:connection",
    tone: "blue",
  },
  {
    title: "Usage budget warning reached 72%",
    meta: "2 hours ago",
    icon: "mdi:cash-multiple",
    tone: "amber",
  },
];

export const executions = [
  {
    id: "run-4821",
    workflow: "ERP Invoice Exception Resolver",
    status: WORKFLOW_STATUS.RUNNING,
    started: "14:21:09",
    duration: "00:01:14",
    tokens: "8.4K",
    cost: "$0.31",
  },
  {
    id: "run-4820",
    workflow: "Customer Refund Auto-Triage",
    status: WORKFLOW_STATUS.DONE,
    started: "14:06:44",
    duration: "00:00:42",
    tokens: "3.1K",
    cost: "$0.09",
  },
  {
    id: "run-4819",
    workflow: "Procurement Risk Escalation",
    status: WORKFLOW_STATUS.HEALING,
    started: "13:58:02",
    duration: "00:02:58",
    tokens: "12.7K",
    cost: "$0.44",
  },
  {
    id: "run-4818",
    workflow: "Inventory Reorder Planner",
    status: WORKFLOW_STATUS.FAILED,
    started: "13:40:17",
    duration: "00:00:36",
    tokens: "1.9K",
    cost: "$0.05",
  },
];

export const logs = [
  "[14:21:09] trigger.erp_event received invoice_id=INV-99214",
  "[14:21:11] action.normalize_payload mapped supplier profile",
  "[14:21:15] llm.classify_intent confidence=0.94 category=duplicate_invoice",
  "[14:21:18] condition.policy_guardrail requires approval threshold review",
  "[14:21:27] healing.retry_connector refreshed ERP token and resumed",
  "[14:22:03] notify.owner queued approval summary to finance lead",
];

export const analyticsSeries = [
  { label: "Mon", runs: 160, cost: 42, healing: 6 },
  { label: "Tue", runs: 188, cost: 45, healing: 8 },
  { label: "Wed", runs: 214, cost: 51, healing: 11 },
  { label: "Thu", runs: 231, cost: 56, healing: 10 },
  { label: "Fri", runs: 268, cost: 62, healing: 14 },
  { label: "Sat", runs: 190, cost: 39, healing: 7 },
];

export const users = [
  { name: "Lakshan Jay", role: "Platform Admin", status: "Active", initials: "LJ" },
  { name: "Maya Silva", role: "Workflow Builder", status: "Active", initials: "MS" },
  { name: "Naveen Perera", role: "Execution Reviewer", status: "Invited", initials: "NP" },
  { name: "Asha Fernando", role: "Auditor", status: "Active", initials: "AF" },
];

export const integrations = [
  { name: "ERP Sandbox", type: "MCP Server", status: "Connected", icon: "mdi:server" },
  { name: "GitHub Actions", type: "CI/CD", status: "Connected", icon: "mdi:github" },
  { name: "Sentry", type: "Monitoring", status: "Needs token", icon: "simple-icons:sentry" },
];

export const chatMessages = [
  {
    role: "assistant",
    text: "Describe the workflow you want and I will turn it into a validated YAML blueprint.",
  },
  {
    role: "user",
    text: "When an ERP invoice is duplicated, classify the reason, retry connector failures, then notify finance.",
  },
  {
    role: "assistant",
    text: "Drafted a 7-step workflow with policy checks, self-healing retry, and human approval routing.",
  },
];

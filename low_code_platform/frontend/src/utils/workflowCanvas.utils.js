import { MarkerType } from "@xyflow/react";
import { readCanvasBlueprint } from "./builderSerialization";
import { projectStructuredControlFlow } from "./structuredCanvasProjection";

const CANVAS_WORKFLOW_KEY = "workflow.pendingCanvasWorkflow";
const CHAT_EDIT_KEY = "workflow.pendingChatEdit";

const actionMeta = {
  "procurement.validate_vendor": {
    label: "Validate Vendor",
    iconKey: "UserCheck",
    role: "procurement_officer",
    tone: "emerald",
  },
  "policy.check_policy_limit": {
    label: "Policy Check",
    iconKey: "ShieldCheck",
    role: "policy",
    tone: "blue",
  },
  "approval.request_human_approval": {
    label: "Human Approval",
    iconKey: "UserSearch",
    role: "procurement_manager",
    tone: "amber",
  },
  "procurement.create_purchase_order": {
    label: "Create PO",
    iconKey: "ShoppingCart",
    role: "procurement_officer",
    tone: "purple",
  },
  "audit.write_audit_log": {
    label: "Audit Log",
    iconKey: "FileCheck2",
    role: "auditor",
    tone: "sky",
  },
};

/*******************************************************************************
 * Function: saveWorkflowForCanvas
 *
 * Saves workflow for canvas for the workflowCanvas utils module.
 ******************************************************************************/
export function saveWorkflowForCanvas(payload) {
  localStorage.setItem(CANVAS_WORKFLOW_KEY, JSON.stringify(payload));
}

/*******************************************************************************
 * Function: takeWorkflowForCanvas
 *
 * Performs the take Workflow For Canvas operation on workflow for canvas for the workflowCanvas utils module.
 ******************************************************************************/
// ── Chat-edit round-trip helpers ─────────────────────────────────────────────
// saveWorkflowForChatEdit: called from canvas when user clicks "Edit in Chat"
// payload: { yaml, workflowId, workflowName }
/*******************************************************************************
 * Function: saveWorkflowForChatEdit
 *
 * Saves workflow for chat edit for the workflowCanvas utils module.
 ******************************************************************************/
export function saveWorkflowForChatEdit(payload) {
  localStorage.setItem(CHAT_EDIT_KEY, JSON.stringify(payload));
}

/*******************************************************************************
 * Function: takeWorkflowForChatEdit
 *
 * Performs the take Workflow For Chat Edit operation on workflow for chat edit for the workflowCanvas utils module.
 ******************************************************************************/
export function takeWorkflowForChatEdit() {
  const raw = localStorage.getItem(CHAT_EDIT_KEY);
  if (!raw) return null;
  localStorage.removeItem(CHAT_EDIT_KEY);
  try { return JSON.parse(raw); } catch { return null; }
}

/*******************************************************************************
 * Function: peekWorkflowForChatEdit
 *
 * Performs the peek Workflow For Chat Edit operation on workflow for chat edit for the workflowCanvas utils module.
 ******************************************************************************/
export function peekWorkflowForChatEdit() {
  const raw = localStorage.getItem(CHAT_EDIT_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/*******************************************************************************
 * Function: clearWorkflowForChatEdit
 *
 * Clears workflow for chat edit for the workflowCanvas utils module.
 ******************************************************************************/
export function clearWorkflowForChatEdit() {
  localStorage.removeItem(CHAT_EDIT_KEY);
}

/*******************************************************************************
 * Function: takeWorkflowForCanvas
 *
 * Performs the take Workflow For Canvas operation on workflow for canvas for the workflowCanvas utils module.
 ******************************************************************************/
export function takeWorkflowForCanvas() {
  const raw = localStorage.getItem(CANVAS_WORKFLOW_KEY);
  if (!raw) return null;
  localStorage.removeItem(CANVAS_WORKFLOW_KEY);

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function peekWorkflowForCanvas() {
  try { return JSON.parse(localStorage.getItem(CANVAS_WORKFLOW_KEY) || "null"); } catch { return null; }
}

export function clearWorkflowForCanvas(expected) {
  try {
    if (JSON.stringify(peekWorkflowForCanvas()) === JSON.stringify(expected)) localStorage.removeItem(CANVAS_WORKFLOW_KEY);
  } catch { /* Disabled storage must not break a read-only preview. */ }
}

/*******************************************************************************
 * Function: parseWorkflowYaml
 *
 * Parses workflow yaml for the workflowCanvas utils module.
 ******************************************************************************/
export function parseWorkflowYaml(yaml = "") {
  return readCanvasBlueprint(yaml);
}

/*******************************************************************************
 * Function: workflowYamlToCanvas
 *
 * Performs the workflow Yaml To Canvas operation on yaml to canvas for the workflowCanvas utils module.
 ******************************************************************************/
export function workflowYamlToCanvas(yaml, metadata = {}) {
  const workflow = parseWorkflowYaml(yaml);
  const structured = projectStructuredControlFlow(workflow, MarkerType.ArrowClosed);
  if (structured) return {
    ...structured,
    workflow: {
      id: metadata.workflowId ?? null,
      name: workflow.name || metadata.name || "Generated workflow",
      description: workflow.description || metadata.description || "",
      yaml,
      canvasProfile: structured.profile,
      candidateId: metadata.candidateId,
      chatSessionId: metadata.chatSessionId,
      chatMessageId: metadata.chatMessageId,
      traceId: metadata.traceId,
    },
  };
/*******************************************************************************
 * Function: nodes
 *
 * Performs the nodes operation on the application for the workflowCanvas utils module.
 ******************************************************************************/
  const nodes = workflow.steps.map((step, index) => {
    const meta = actionMeta[step.action] ?? {};
    return {
      id: step.id || `step-${index + 1}`,
      type: "erpTool",
      position: { x: 120 + index * 330, y: index % 2 === 0 ? 160 : 330 },
      data: {
        label: meta.label ?? (step.description?.trim() || humanizeAction(step.action ?? step.kind)),
        action: step.action ?? step.kind ?? "Unsupported node",
        description: step.description ?? "",
        source: step,
        iconKey: meta.iconKey ?? "Database",
        role: meta.role ?? "system",
        status: "idle",
        tone: meta.tone ?? "blue",
        parameters: step.parameters ?? {},
      },
    };
  });

/*******************************************************************************
 * Function: edges
 *
 * Performs the edges operation on the application for the workflowCanvas utils module.
 ******************************************************************************/
  const edges = nodes.slice(1).map((node, index) => ({
    id: `edge-${nodes[index].id}-${node.id}`,
    source: nodes[index].id,
    target: node.id,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: "#475569", strokeWidth: 2 },
  }));

  return {
    nodes,
    edges,
    workflow: {
      id: metadata.workflowId ?? null,
      name: workflow.name || metadata.name || "Generated workflow",
      description: workflow.description || metadata.description || "",
      yaml,
      candidateId: metadata.candidateId,
      chatSessionId: metadata.chatSessionId,
      chatMessageId: metadata.chatMessageId,
      traceId: metadata.traceId,
    },
  };
}

/*******************************************************************************
 * Function: workflowCreationPayload
 *
 * Performs the workflow Creation Payload operation on creation payload for the workflowCanvas utils module.
 ******************************************************************************/
export function workflowCreationPayload(workflow, yaml) {
  return {
    name: workflow.name,
    description: workflow.description,
    yaml,
    ...(workflow.chatSessionId && workflow.chatMessageId
      ? {
          chatSessionId: workflow.chatSessionId,
          chatMessageId: workflow.chatMessageId,
        }
      : {}),
    ...(workflow.traceId ? { traceId: workflow.traceId } : {}),
  };
}

/*******************************************************************************
 * Function: humanizeAction
 *
 * Provides a readable display label without changing executable tool names.
 ******************************************************************************/
function humanizeAction(action = "") {
  return action
    .split(".")
    .pop()
    ?.replaceAll("_", " ")
    .replace(/\b\w/g, (char) => char.toUpperCase()) || "Workflow Step";
}

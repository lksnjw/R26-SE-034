import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { serializeSourceOrderCanvas, sameWorkflowSource } from "../../utils/builderSerialization";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertCircle,
  Boxes,
  CheckCircle2,
  Database,
  FileCheck2,
  GripVertical,
  Loader2,
  Mail,
  PackageCheck,
  Search,
  ShieldCheck,
  ShoppingCart,
  UserCheck,
  UserSearch,
  Warehouse,
  Zap,
} from "lucide-react";
import {
  peekWorkflowForCanvas,
  clearWorkflowForCanvas,
  workflowCreationPayload,
  workflowYamlToCanvas,
  saveWorkflowForChatEdit,
} from "../../utils/workflowCanvas.utils";
import { catalogService } from "../../services/catalog.service";
import { workflowService } from "../../services/workflow.service";
import { executionService } from "../../services/execution.service";
import { apiErrorDetails, apiErrorMessage } from "../../services/api";
import { useNotifications } from "../../context/NotificationContext";
import BuilderModeControls from "./BuilderModeControls";
import GateRejectionAlert from "../workflows/GateRejectionAlert";

const iconMap = {
  AlertCircle,
  Boxes,
  Database,
  FileCheck2,
  Mail,
  PackageCheck,
  Search,
  ShieldCheck,
  ShoppingCart,
  UserCheck,
  UserSearch,
  Warehouse,
};


const statusMeta = {
  idle: {
    label: "Idle",
    border: "border-slate-200",
    glow: "shadow-[0_18px_38px_rgba(15,23,42,0.08)]",
    badge: "bg-slate-100 text-slate-600",
    icon: null,
  },
  running: {
    label: "Running",
    border: "border-blue-500 ring-4 ring-blue-500/15",
    glow: "shadow-[0_0_32px_rgba(37,99,235,0.35)]",
    badge: "bg-blue-50 text-blue-700",
    icon: Loader2,
  },
  success: {
    label: "Success",
    border: "border-emerald-500",
    glow: "shadow-[0_0_28px_rgba(16,185,129,0.22)]",
    badge: "bg-emerald-50 text-emerald-700",
    icon: CheckCircle2,
  },
  error: {
    label: "Error",
    border: "border-red-500",
    glow: "shadow-[0_0_28px_rgba(220,38,38,0.22)]",
    badge: "bg-red-50 text-red-700",
    icon: AlertCircle,
  },
};

const toneClasses = {
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  blue: "bg-blue-50 text-blue-700 border-blue-200",
  emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
  green: "bg-green-50 text-green-700 border-green-200",
  purple: "bg-purple-50 text-purple-700 border-purple-200",
  rose: "bg-rose-50 text-rose-700 border-rose-200",
  sky: "bg-sky-50 text-sky-700 border-sky-200",
  violet: "bg-violet-50 text-violet-700 border-violet-200",
};

/*******************************************************************************
 * Function: getInitialCanvasState
 *
 * Gets initial canvas state for the WorkflowBuilderCanvas module.
 ******************************************************************************/
function getInitialCanvasState() {
  const pendingWorkflow = peekWorkflowForCanvas();
  if (pendingWorkflow?.yaml) {
    try {
    const canvas = workflowYamlToCanvas(pendingWorkflow.yaml, {
      candidateId: pendingWorkflow.candidateId,
      chatSessionId: pendingWorkflow.chatSessionId,
      chatMessageId: pendingWorkflow.chatMessageId,
      traceId: pendingWorkflow.traceId,
      workflowId: pendingWorkflow.workflowId,
    });
    return { ...canvas, payload: pendingWorkflow };
    } catch (error) {
      return { nodes: [], edges: [], payload: pendingWorkflow, sourceError: error.message, workflow: { id: pendingWorkflow.workflowId ?? null, name: pendingWorkflow.name || "Unsupported imported draft", description: "Source preserved; no graph semantics inferred.", yaml: pendingWorkflow.yaml } };
    }
  }

  return {
    nodes: [],
    edges: [],
    workflow: {
      id: null,
      name: "Untitled workflow",
      description: "Workflow created in the governed visual builder.",
      yaml: "",
    },
  };
}

/*******************************************************************************
 * Function: WorkflowToolNode
 *
 * Performs the Workflow Tool Node operation on tool node for the WorkflowBuilderCanvas module.
 ******************************************************************************/
function WorkflowToolNode({ data, selected }) {
  const Icon = iconMap[data.iconKey] ?? Database;
  const meta = statusMeta[data.status ?? "idle"] ?? statusMeta.idle;
  const StatusIcon = meta.icon;

  return (
    <div
      className={`min-w-[236px] rounded-lg border bg-white px-4 py-3 text-slate-950 transition-all duration-200 ${meta.border} ${meta.glow} ${
        selected ? "outline outline-2 outline-offset-2 outline-slate-900/20" : ""
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-3 !w-3 !border-2 !border-white !bg-slate-400"
      />
      <div className="flex items-start gap-3">
        <span
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border ${
            toneClasses[data.tone] ?? toneClasses.blue
          }`}
        >
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-slate-950">{data.label}</p>
              <p className="mt-1 truncate text-xs font-semibold text-slate-500">{data.action}</p>
            </div>
            <span
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-bold ${meta.badge}`}
            >
              {StatusIcon ? (
                <StatusIcon
                  className={`h-3.5 w-3.5 ${data.status === "running" ? "animate-spin" : ""}`}
                />
              ) : null}
              {meta.label}
            </span>
          </div>
          <p className="mt-3 line-clamp-2 text-xs leading-5 text-slate-500">{data.description}</p>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-[11px] font-bold uppercase tracking-wide text-slate-400">
        <span>{data.role}</span>
        <span>{data.status === "running" ? "Executing" : "ERP Tool"}</span>
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!h-3 !w-3 !border-2 !border-white !bg-slate-700"
      />
    </div>
  );
}

/*******************************************************************************
 * Function: ToolCatalogItem
 *
 * Performs the Tool Catalog Item operation on catalog item for the WorkflowBuilderCanvas module.
 ******************************************************************************/
function ToolCatalogItem({ tool }) {
  const Icon = iconMap[tool.iconKey] ?? Database;

/*******************************************************************************
 * Function: handleDragStart
 *
 * Handles drag start for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const handleDragStart = (event) => {
    event.dataTransfer.setData("application/agentic-tool", JSON.stringify(tool));
    event.dataTransfer.effectAllowed = "move";
  };

  return (
    <button
      type="button"
      draggable
      onDragStart={handleDragStart}
      className="group flex w-full items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-slate-400 hover:shadow-md"
    >
      <span
        className={`mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${
          toneClasses[tool.tone] ?? toneClasses.blue
        }`}
      >
        <Icon className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-slate-900">{tool.label}</span>
        <span className="mt-1 block text-xs leading-5 text-slate-500">{tool.description}</span>
      </span>
      <GripVertical className="mt-2 h-4 w-4 shrink-0 text-slate-300 transition group-hover:text-slate-500" />
    </button>
  );
}

/*******************************************************************************
 * Function: BuilderSidebar
 *
 * Performs the Builder Sidebar operation on sidebar for the WorkflowBuilderCanvas module.
 ******************************************************************************/
function BuilderSidebar({ groups = [], loading, error }) {
  return (
    <aside className="flex h-screen w-[300px] shrink-0 flex-col border-r border-slate-200 bg-slate-50">
      <div className="border-b border-slate-200 px-5 py-5">
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-slate-400">Tool Catalog</p>
        <h2 className="mt-2 text-xl font-black text-slate-950">ERP Components</h2>
        <p className="mt-2 text-sm leading-6 text-slate-500">
          Drag tools into the canvas and connect them into governed execution flows.
        </p>
      </div>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-5">
        {loading ? <p className="text-sm text-slate-500">Loading registered tools…</p> : null}
        {error ? <p className="text-sm text-red-600">{apiErrorMessage(error, "Tool catalog unavailable.")}</p> : null}
        {!loading && !error && groups.length === 0 ? <p className="text-sm text-slate-500">No available tools are registered.</p> : null}
        {groups.map((group) => (
          <section key={group.title}>
            <div className="mb-3">
              <h3 className="text-sm font-extrabold text-slate-900">{group.title}</h3>
              <p className="mt-1 text-xs leading-5 text-slate-500">{group.description}</p>
            </div>
            <div className="grid gap-3">
              {group.tools.map((tool) => (
                <ToolCatalogItem key={`${group.title}-${tool.label}`} tool={tool} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </aside>
  );
}

/*******************************************************************************
 * Function: extractReadableData
 *
 * Performs the extract Readable Data operation on readable data for the WorkflowBuilderCanvas module.
 ******************************************************************************/
function extractReadableData(raw) {
  if (raw === null || raw === undefined) return null;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    if (Array.isArray(raw.structuredContent?.data)) return raw.structuredContent.data;
    if (Array.isArray(raw.content) && raw.content[0]?.type === "text") {
      try {
        const parsed = JSON.parse(raw.content[0].text);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.data)) return parsed.data;
        return parsed;
      } catch { return raw.content[0].text; }
    }
    if (Array.isArray(raw.data)) return raw.data;
  }
  if (Array.isArray(raw) && raw.length > 0 && raw[0]?.type === "text") {
    try {
      const parsed = JSON.parse(raw[0].text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray(parsed.data)) return parsed.data;
      return parsed;
    } catch { return raw[0].text; }
  }
  return raw;
}

/*******************************************************************************
 * Function: SmartOutput
 *
 * Performs the Smart Output operation on output for the WorkflowBuilderCanvas module.
 ******************************************************************************/
function SmartOutput({ value, maxHeight = "max-h-64" }) {
  const data = extractReadableData(value);
  if (Array.isArray(data) && data.length > 0 && data[0] !== null && typeof data[0] === "object") {
    const keys = Object.keys(data[0]).filter((k) => data[0][k] !== null && data[0][k] !== undefined);
    return (
      <div className={`${maxHeight} overflow-y-auto space-y-2`}>
        {data.map((item, i) => (
          <div key={i} className="rounded-md border border-slate-200 bg-white p-2.5 text-xs">
            {keys.map((k) => item[k] !== null && item[k] !== undefined ? (
              <div key={k} className="flex gap-2 py-0.5">
                <span className="w-28 shrink-0 font-semibold text-slate-400 capitalize">{k.replaceAll("_", " ")}</span>
                <span className="text-slate-800 break-all">{String(item[k])}</span>
              </div>
            ) : null)}
          </div>
        ))}
        <p className="text-[10px] text-slate-400 pt-1">{data.length} record{data.length !== 1 ? "s" : ""}</p>
      </div>
    );
  }
  if (typeof data === "string") return <p className="text-xs text-slate-700 whitespace-pre-wrap">{data}</p>;
  return (
    <pre className={`${maxHeight} overflow-auto rounded-lg bg-slate-900 p-3 text-[10px] leading-4 text-green-300`}>
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

/*******************************************************************************
 * Function: ExecutionResultPanel
 *
 * Performs the Execution Result Panel operation on result panel for the WorkflowBuilderCanvas module.
 ******************************************************************************/
function ExecutionResultPanel({ result, onClose }) {
  if (!result) return null;
  const { execution, timeline } = result;
  const succeeded = execution?.status === "DONE";

  return (
    <aside className="flex h-screen w-80 shrink-0 flex-col overflow-y-auto border-l border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
        <div className="flex items-center gap-2">
          {succeeded ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
          ) : (
            <AlertCircle className="h-5 w-5 text-red-500" />
          )}
          <h3 className="text-sm font-black text-slate-900">Execution Result</h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          title="Close"
        >
          ✕
        </button>
      </div>

      <div className="space-y-4 p-4">
        <div className={`rounded-lg border p-3 text-xs ${succeeded ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}>
          <p className={`font-bold uppercase tracking-wide ${succeeded ? "text-emerald-700" : "text-red-700"}`}>
            {execution?.status ?? "—"}
          </p>
          <p className="mt-1 font-mono text-[10px] text-slate-500">{execution?.id}</p>
          {(execution?.durationMs ?? 0) > 0 && (
            <p className="mt-1 text-slate-600">{execution.durationMs} ms</p>
          )}
        </div>

        {Array.isArray(timeline) && timeline.length > 0 && (
          <div>
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">Steps</p>
            <div className="space-y-2">
              {timeline.map((step, i) => (
                <div key={step.nodeId ?? i} className="rounded-lg border border-slate-100 bg-slate-50 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate text-xs font-semibold text-slate-800">{step.label ?? step.nodeId}</p>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${step.status === "DONE" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                      {step.status}
                    </span>
                  </div>
                  {step.output && (
                    <div className="mt-1.5">
                      <SmartOutput value={step.output} maxHeight="max-h-24" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {execution?.finalOutput && (
          <div>
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">Final Output</p>
            <SmartOutput value={execution.finalOutput} maxHeight="max-h-72" />
          </div>
        )}

        {execution?.stepOutputs && Object.keys(execution.stepOutputs).length > 0 && !execution?.finalOutput && (
          <div>
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">Step Outputs</p>
            {Object.entries(execution.stepOutputs).map(([stepId, val]) => (
              <div key={stepId} className="mb-3">
                <p className="mb-1 font-mono text-[10px] text-slate-400">{stepId}</p>
                <SmartOutput value={val} maxHeight="max-h-56" />
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

/*******************************************************************************
 * Function: BuilderHeader
 *
 * Performs the Builder Header operation on header for the WorkflowBuilderCanvas module.
 ******************************************************************************/
function BuilderHeader({ executionState, isExecuting, onRun, onDeploy, readOnly, statusCounts, workflow, onEditInChat }) {
  const stateCopy = {
    idle: "Draft · readiness not checked",
    running: "Running workflow",
    success: "Last run succeeded",
    error: "Run stopped with error",
  };

  return (
    <header className="flex h-[76px] shrink-0 items-center justify-between border-b border-slate-200 bg-white px-6">
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-950 text-white">
            <Zap className="h-5 w-5" />
          </span>
          <div>
            <h1 className="max-w-[520px] truncate text-lg font-black text-slate-950">
              {workflow?.name || "Agentic Workflow Builder"}
            </h1>
            <p className="mt-0.5 text-xs font-semibold text-slate-500">
              {stateCopy[executionState]} · {statusCounts.running} running · {statusCounts.success} success ·{" "}
              {statusCounts.error} error
            </p>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {onEditInChat && (
          <button
            type="button"
            onClick={onEditInChat}
            className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-sm transition hover:border-slate-400 hover:bg-slate-50"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-none stroke-current stroke-2"><path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>
            Edit in Chat
          </button>
        )}
        <BuilderModeControls
          readOnly={readOnly}
          isExecuting={isExecuting}
          onDeploy={onDeploy}
          onRun={onRun}
        />
      </div>
    </header>
  );
}

/*******************************************************************************
 * Function: WorkflowBuilderSurface
 *
 * Performs the Workflow Builder Surface operation on builder surface for the WorkflowBuilderCanvas module.
 ******************************************************************************/
function WorkflowBuilderSurface({ readOnly = false, initialState = null, embedded = false }) {
  const navigate = useNavigate();
  const reactFlowWrapper = useRef(null);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const [initialCanvasState] = useState(() => initialState ?? getInitialCanvasState());
  useEffect(() => { if (initialCanvasState.payload && !initialCanvasState.sourceError) clearWorkflowForCanvas(initialCanvasState.payload); }, [initialCanvasState]);
  const nodeIdRef = useRef(initialCanvasState.nodes.length + 1);
  const [nodes, setNodes] = useState(initialCanvasState.nodes);
  const [edges, setEdges] = useState(initialCanvasState.edges);
  const [workflow, setWorkflow] = useState(initialCanvasState.workflow);
  const [executionState, setExecutionState] = useState("idle");
  const [isExecuting, setIsExecuting] = useState(false);
  const [runError, setRunError] = useState(null);
  const [executionResult, setExecutionResult] = useState(null);
  const [showResultPanel, setShowResultPanel] = useState(false);
  const { notify } = useNotifications();
/*******************************************************************************
 * Function: catalogQuery
 *
 * Performs the catalog Query operation on query for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const catalogQuery = useQuery({
    queryKey: ["tool-catalog-groups"],
    queryFn: () => catalogService.toolGroups(),
    enabled: !readOnly && !embedded,
  });
/*******************************************************************************
 * Function: nodeTypes
 *
 * Performs the node Types operation on types for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const nodeTypes = useMemo(() => ({ erpTool: WorkflowToolNode }), []);

/*******************************************************************************
 * Function: statusCounts
 *
 * Performs the status Counts operation on counts for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const statusCounts = useMemo(
    () =>
      nodes.reduce(
        (accumulator, node) => {
          const status = node.data.status ?? "idle";
          accumulator[status] = (accumulator[status] ?? 0) + 1;
          return accumulator;
        },
        { idle: 0, running: 0, success: 0, error: 0 },
      ),
    [nodes],
  );

/*******************************************************************************
 * Function: onNodesChange
 *
 * Performs the on Nodes Change operation on nodes change for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const onNodesChange = useCallback((changes) => {
    setNodes((currentNodes) => applyNodeChanges(changes, currentNodes));
  }, []);

/*******************************************************************************
 * Function: onEdgesChange
 *
 * Performs the on Edges Change operation on edges change for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const onEdgesChange = useCallback((changes) => {
    setEdges((currentEdges) => applyEdgeChanges(changes, currentEdges));
  }, []);

/*******************************************************************************
 * Function: onConnect
 *
 * Performs the on Connect operation on connect for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const onConnect = useCallback((connection) => {
    setEdges((currentEdges) =>
      addEdge(
        {
          ...connection,
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { stroke: "#475569", strokeWidth: 2 },
        },
        currentEdges,
      ),
    );
  }, []);

/*******************************************************************************
 * Function: handleDragOver
 *
 * Handles drag over for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const handleDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

/*******************************************************************************
 * Function: handleDrop
 *
 * Handles drop for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const handleDrop = useCallback(
    (event) => {
      event.preventDefault();

      const rawTool = event.dataTransfer.getData("application/agentic-tool");
      if (!rawTool) return;

      const tool = JSON.parse(rawTool);
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const nextId = `node-${nodeIdRef.current}`;
      nodeIdRef.current += 1;

      setNodes((currentNodes) => [
        ...currentNodes,
        {
          id: nextId,
          type: "erpTool",
          position,
          data: {
            ...tool,
            status: "idle",
          },
        },
      ]);
    },
    [screenToFlowPosition],
  );

/*******************************************************************************
 * Function: workflowYAML
 *
 * Performs the workflow YAML operation on yaml for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const workflowYAML = useCallback(() => serializeSourceOrderCanvas(workflow, nodes, edges), [edges, nodes, workflow]);

/*******************************************************************************
 * Function: deployWorkflow
 *
 * Performs the deploy Workflow operation on workflow for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const deployWorkflow = useCallback(async () => {
    if (nodes.length === 0) throw new Error("Add at least one registered tool before deploying.");
    const yaml = workflowYAML();
    let saved = workflow;
    let reviewed;
    if (workflow.id) {
      const revision = await workflowService.readiness(workflow.id);
      if (!workflow.yaml || !sameWorkflowSource(revision.yaml, workflow.yaml)) throw new Error("Saved draft changed. Reload it in the chat workspace before publishing.");
      reviewed = await workflowService.command(workflow.id, revision, { type: "restoreDraft", yaml });
    } else {
      saved = await workflowService.create(
        workflowCreationPayload(workflow, yaml),
      );
      reviewed = await workflowService.readiness(saved.id);
      if (!sameWorkflowSource(reviewed.yaml, yaml)) throw new Error("Created draft changed. Reload before publishing.");
    }
    // Retain the saved draft even if publication fails; a second attempt must
    // not create another workflow or forget the acknowledged draft revision.
    saved = { ...saved, id: saved.id, yaml };
    setWorkflow(saved);
    await workflowService.publish(saved.id, "Published from visual builder", reviewed);
    fitView({ padding: 0.2, duration: 400 });
    notify(`Workflow ${saved.name} published. It has not been executed.`, "success");
    return saved;
  }, [fitView, nodes.length, notify, workflow, workflowYAML]);

/*******************************************************************************
 * Function: executeWorkflow
 *
 * Executes workflow for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const executeWorkflow = useCallback(async () => {
    if (isExecuting || nodes.length === 0) return;
    setIsExecuting(true);
    setExecutionState("running");
    setRunError(null);
    setNodes((currentNodes) =>
      currentNodes.map((node) => ({
        ...node,
        data: { ...node.data, status: "idle" },
      })),
    );

    try {
      if (!workflow.id) throw new Error("Save and explicitly publish this draft before requesting execution. Run does not publish.");
      const readiness = await workflowService.readiness(workflow.id);
      if (!sameWorkflowSource(workflowYAML(), readiness.yaml)) throw new Error("Canvas has unsaved changes. Review and publish them explicitly before running.");
      if (!readiness.can_attempt_run) throw new Error("The saved workflow is not ready: check publication, validation, supported semantics and ERP connection in the chat workspace.");
      const execution = await workflowService.run(workflow.id, {});
      const timeline = await executionService.getTimeline(execution.id);
/*******************************************************************************
 * Function: statusByNode
 *
 * Performs the status By Node operation on by node for the WorkflowBuilderCanvas module.
 ******************************************************************************/
      const statusByNode = new Map(timeline.map((step) => [step.nodeId, step.status]));
      setNodes((currentNodes) =>
        currentNodes.map((node) => ({
          ...node,
          data: { ...node.data, status: statusByNode.get(node.id) === "DONE" ? "success" : statusByNode.get(node.id) === "FAILED" ? "error" : "idle" },
        })),
      );
      const succeeded = execution.status === "DONE";
      setExecutionState(succeeded ? "success" : "error");
      setExecutionResult({ execution, timeline });
      setShowResultPanel(true);
      notify(`Execution ${execution.id} finished with status ${execution.status}.`, succeeded ? "success" : "warning");
    } catch (error) {
      setExecutionState("error");
      const details = error?.response ? apiErrorDetails(error, "Workflow execution failed.") : { message: error.message || "Workflow execution failed.", meta: null };
      setRunError(details);
      notify(details.message, "error");
      const executionId = error?.response?.data?.meta?.executionId;
      if (executionId) {
        try {
          const [execution, timeline] = await Promise.all([executionService.get(executionId), executionService.getTimeline(executionId)]);
          const statuses = new Map(timeline.map((step) => [step.nodeId, step.status]));
          setNodes((items) => items.map((node) => ({ ...node, data: { ...node.data, status: statuses.get(node.id) === "DONE" ? "success" : statuses.get(node.id) === "FAILED" ? "error" : "idle" } })));
          setExecutionResult({ execution, timeline }); setShowResultPanel(true);
        } catch { notify("The failed run was recorded, but its details could not be loaded.", "warning"); }
      }
    } finally {
      setIsExecuting(false);
    }
  }, [isExecuting, nodes.length, notify, workflow, workflowYAML]);

/*******************************************************************************
 * Function: handleDeploy
 *
 * Handles deploy for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const handleDeploy = useCallback(async () => {
    setIsExecuting(true);
    try { await deployWorkflow(); }
    catch (error) { notify(error?.response ? apiErrorMessage(error, "Workflow publication failed.") : error.message || "Workflow publication failed.", "error"); }
    finally { setIsExecuting(false); }
  }, [deployWorkflow, notify]);

  const handleEditInChat = useCallback(() => {
    let yaml = workflow.yaml || "";
    if (!yaml && nodes.length > 0) {
      try { yaml = workflowYAML(); } catch { /* cycle or empty */ }
    }
    saveWorkflowForChatEdit({ yaml, workflowId: workflow.id ?? null, workflowName: workflow.name });
    navigate("/chat?new=1");
  }, [workflow, nodes, workflowYAML, navigate]);

  return (
    <div className={`${embedded ? "relative h-full" : "fixed inset-y-0 right-0 left-0 z-50 md:left-16"} flex overflow-hidden bg-slate-100 text-slate-950`}>
      {!readOnly && !embedded ? <BuilderSidebar groups={catalogQuery.data || []} loading={catalogQuery.isLoading} error={catalogQuery.error} /> : null}
      <section className="flex min-w-0 flex-1 flex-col">
        <BuilderHeader
          executionState={executionState}
          isExecuting={isExecuting}
          onRun={executeWorkflow}
          onDeploy={handleDeploy}
          readOnly={readOnly}
          statusCounts={statusCounts}
          workflow={workflow}
          onEditInChat={nodes.length > 0 || workflow.yaml ? handleEditInChat : undefined}
        />
        {runError ? <div className="shrink-0 bg-white px-6 py-2"><GateRejectionAlert details={runError} /></div> : null}
        {initialCanvasState.sourceError && <div role="alert" className="shrink-0 border-b border-amber-200 bg-amber-50 px-6 py-3 text-xs text-amber-800"><p>Import cannot be represented: {initialCanvasState.sourceError}. Its source is preserved; nothing was saved or published.</p><details className="mt-2"><summary>Original source</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap">{workflow.yaml}</pre></details><button className="mt-2 underline" onClick={handleEditInChat}>Review source in chat</button></div>}
        <div className="min-h-0 flex-1 bg-slate-100 p-4">
          <div
            ref={reactFlowWrapper}
            className="h-full overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_20px_50px_rgba(15,23,42,0.10)]"
          >
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={readOnly ? undefined : onNodesChange}
              onEdgesChange={readOnly ? undefined : onEdgesChange}
              onConnect={readOnly ? undefined : onConnect}
              onDrop={readOnly ? undefined : handleDrop}
              onDragOver={readOnly ? undefined : handleDragOver}
              nodesDraggable={!readOnly}
              nodesConnectable={!readOnly}
              elementsSelectable={!readOnly}
              fitView
              defaultEdgeOptions={{
                type: "smoothstep",
                markerEnd: { type: MarkerType.ArrowClosed },
              }}
              connectionLineStyle={{ stroke: "#2563eb", strokeWidth: 2 }}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#cbd5e1" gap={24} size={1.4} />
              <Controls position="bottom-right" />
              <MiniMap
                position="bottom-left"
                nodeColor={(node) => {
                  if (node.data.status === "running") return "#2563eb";
                  if (node.data.status === "success") return "#10b981";
                  if (node.data.status === "error") return "#dc2626";
                  return "#94a3b8";
                }}
                maskColor="rgba(15, 23, 42, 0.08)"
              />
            </ReactFlow>
          </div>
        </div>
      </section>
      {showResultPanel && executionResult ? (
        <ExecutionResultPanel
          result={executionResult}
          onClose={() => setShowResultPanel(false)}
        />
      ) : null}
    </div>
  );
}

/*******************************************************************************
 * Function: BuilderLoadState
 *
 * Performs the Builder Load State operation on load state for the WorkflowBuilderCanvas module.
 ******************************************************************************/
function BuilderLoadState({ embedded, error }) {
  return (
    <div className={`${embedded ? "relative h-full" : "fixed inset-y-0 right-0 left-0 z-50 md:left-16"} grid place-items-center bg-slate-100 p-6 text-center`}>
      <p className={`text-sm font-semibold ${error ? "text-red-600" : "text-slate-500"}`}>
        {error ? apiErrorMessage(error, "Workflow preview unavailable.") : "Loading workflow preview..."}
      </p>
    </div>
  );
}

/*******************************************************************************
 * Function: WorkflowBuilderCanvas
 *
 * Performs the Workflow Builder Canvas operation on builder canvas for the WorkflowBuilderCanvas module.
 ******************************************************************************/
function WorkflowBuilderCanvas({ readOnly = false, workflowId = null, embedded = false }) {
/*******************************************************************************
 * Function: workflowQuery
 *
 * Performs the workflow Query operation on query for the WorkflowBuilderCanvas module.
 ******************************************************************************/
  const workflowQuery = useQuery({
    queryKey: ["builder-workflow", workflowId],
    queryFn: async () => {
      const [record, yamlRecord] = await Promise.all([
        workflowService.getById(workflowId),
        workflowService.getYAML(workflowId),
      ]);
      const canvas = workflowYamlToCanvas(yamlRecord.yaml, {
        name: record.name,
        description: record.description,
      });
      return {
        ...canvas,
        workflow: {
          ...canvas.workflow,
          id: record.id,
          name: record.name,
          description: record.description,
        },
      };
    },
    enabled: Boolean(workflowId),
  });

  if (workflowId && workflowQuery.isLoading) return <BuilderLoadState embedded={embedded} />;
  if (workflowQuery.error) return <BuilderLoadState embedded={embedded} error={workflowQuery.error} />;

  return (
    <ReactFlowProvider>
      <WorkflowBuilderSurface
        key={workflowId ?? "draft"}
        readOnly={readOnly}
        initialState={workflowQuery.data ?? null}
        embedded={embedded}
      />
    </ReactFlowProvider>
  );
}

export default WorkflowBuilderCanvas;

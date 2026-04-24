import { useCallback, useMemo, useRef, useState } from "react";
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
  Play,
  Rocket,
  Search,
  ShieldCheck,
  ShoppingCart,
  UserCheck,
  UserSearch,
  Warehouse,
  Zap,
} from "lucide-react";

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

const toolCatalog = [
  {
    title: "HR Tools",
    description: "Employee records, leave approvals, and HR notifications.",
    tools: [
      {
        label: "Get Employee",
        action: "fetch_record",
        description: "Fetch employee profile and department metadata.",
        iconKey: "UserSearch",
        role: "hr_manager",
        tone: "violet",
      },
      {
        label: "Approve Leave",
        action: "approve_request",
        description: "Approve a leave request with supervisor controls.",
        iconKey: "UserCheck",
        role: "supervisor",
        tone: "emerald",
      },
      {
        label: "Policy Check",
        action: "check_policy_limit",
        description: "Validate HR or travel request against policy limits.",
        iconKey: "ShieldCheck",
        role: "supervisor",
        tone: "blue",
      },
      {
        label: "Send HR Notice",
        action: "send_email_notification",
        description: "Notify employee, HR, or supervisor by role.",
        iconKey: "Mail",
        role: "hr_manager",
        tone: "amber",
      },
    ],
  },
  {
    title: "Inventory Tools",
    description: "Purchase-to-pay and inventory execution blocks.",
    tools: [
      {
        label: "Check Stock",
        action: "fetch_record",
        description: "Read stock levels and warehouse availability.",
        iconKey: "Boxes",
        role: "warehouse_staff",
        tone: "sky",
      },
      {
        label: "Create PO",
        action: "create_purchase_order",
        description: "Create a governed purchase order for a vendor.",
        iconKey: "ShoppingCart",
        role: "procurement_officer",
        tone: "purple",
      },
      {
        label: "Goods Receipt",
        action: "record_goods_receipt",
        description: "Record goods received against a purchase order.",
        iconKey: "PackageCheck",
        role: "warehouse_staff",
        tone: "green",
      },
      {
        label: "Clear Invoice",
        action: "clear_invoice",
        description: "Clear invoice after receipt and invoice matching.",
        iconKey: "FileCheck2",
        role: "finance_officer",
        tone: "rose",
      },
    ],
  },
];

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

const initialNodes = [
  {
    id: "node-1",
    type: "erpTool",
    position: { x: 120, y: 140 },
    data: {
      label: "Get Employee",
      action: "fetch_record",
      description: "Fetch employee and department context.",
      iconKey: "UserSearch",
      role: "hr_manager",
      status: "idle",
      tone: "violet",
    },
  },
  {
    id: "node-2",
    type: "erpTool",
    position: { x: 450, y: 140 },
    data: {
      label: "Approve Leave",
      action: "approve_request",
      description: "Approve governed leave request.",
      iconKey: "UserCheck",
      role: "supervisor",
      status: "idle",
      tone: "emerald",
    },
  },
  {
    id: "node-3",
    type: "erpTool",
    position: { x: 780, y: 140 },
    data: {
      label: "Send HR Notice",
      action: "send_email_notification",
      description: "Notify employee and HR team.",
      iconKey: "Mail",
      role: "hr_manager",
      status: "idle",
      tone: "amber",
    },
  },
];

const initialEdges = [
  {
    id: "edge-1-2",
    source: "node-1",
    target: "node-2",
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: "#64748b", strokeWidth: 2 },
  },
  {
    id: "edge-2-3",
    source: "node-2",
    target: "node-3",
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: "#64748b", strokeWidth: 2 },
  },
];

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

function ToolCatalogItem({ tool }) {
  const Icon = iconMap[tool.iconKey] ?? Database;

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

function BuilderSidebar() {
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
        {toolCatalog.map((group) => (
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

function BuilderHeader({ executionState, isExecuting, onRun, onDeploy, statusCounts }) {
  const stateCopy = {
    idle: "Ready",
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
            <h1 className="text-lg font-black text-slate-950">Agentic Workflow Builder</h1>
            <p className="mt-0.5 text-xs font-semibold text-slate-500">
              {stateCopy[executionState]} · {statusCounts.running} running · {statusCounts.success} success ·{" "}
              {statusCounts.error} error
            </p>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onDeploy}
          className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 transition hover:bg-slate-50"
        >
          <Rocket className="h-4 w-4" />
          Deploy Workflow
        </button>
        <button
          type="button"
          onClick={onRun}
          disabled={isExecuting}
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-slate-950 px-4 text-sm font-bold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isExecuting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Run Workflow
        </button>
      </div>
    </header>
  );
}

function WorkflowBuilderSurface() {
  const reactFlowWrapper = useRef(null);
  const nodeIdRef = useRef(4);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const [nodes, setNodes] = useState(initialNodes);
  const [edges, setEdges] = useState(initialEdges);
  const [executionState, setExecutionState] = useState("idle");
  const [isExecuting, setIsExecuting] = useState(false);

  const nodeTypes = useMemo(() => ({ erpTool: WorkflowToolNode }), []);

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

  const onNodesChange = useCallback((changes) => {
    setNodes((currentNodes) => applyNodeChanges(changes, currentNodes));
  }, []);

  const onEdgesChange = useCallback((changes) => {
    setEdges((currentEdges) => applyEdgeChanges(changes, currentEdges));
  }, []);

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

  const handleDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

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

  const simulateExecution = useCallback(async () => {
    if (isExecuting || nodes.length === 0) return;

    setIsExecuting(true);
    setExecutionState("running");
    setNodes((currentNodes) =>
      currentNodes.map((node) => ({
        ...node,
        data: { ...node.data, status: "idle" },
      })),
    );

    for (const node of nodes) {
      setNodes((currentNodes) =>
        currentNodes.map((currentNode) =>
          currentNode.id === node.id
            ? { ...currentNode, data: { ...currentNode.data, status: "running" } }
            : currentNode,
        ),
      );

      // Hook your Go backend execution API here, for example:
      // await executionService.runWorkflowStep(workflowId, node.data.action, node.data.parameters)
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const nextStatus = node.data.shouldFail ? "error" : "success";
      setNodes((currentNodes) =>
        currentNodes.map((currentNode) =>
          currentNode.id === node.id
            ? { ...currentNode, data: { ...currentNode.data, status: nextStatus } }
            : currentNode,
        ),
      );

      if (nextStatus === "error") {
        setExecutionState("error");
        setIsExecuting(false);
        return;
      }
    }

    setExecutionState("success");
    setIsExecuting(false);
  }, [isExecuting, nodes]);

  const deployWorkflow = useCallback(() => {
    // Hook your Go backend deploy API here, for example:
    // await workflowService.deployWorkflow({ nodes, edges })
    fitView({ padding: 0.2, duration: 400 });
  }, [fitView]);

  return (
    <div className="fixed inset-0 z-50 flex h-screen w-screen overflow-hidden bg-slate-100 text-slate-950">
      <BuilderSidebar />
      <section className="flex min-w-0 flex-1 flex-col">
        <BuilderHeader
          executionState={executionState}
          isExecuting={isExecuting}
          onRun={simulateExecution}
          onDeploy={deployWorkflow}
          statusCounts={statusCounts}
        />
        <div className="min-h-0 flex-1 bg-slate-100 p-4">
          <div
            ref={reactFlowWrapper}
            className="h-full min-h-[640px] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-[0_20px_50px_rgba(15,23,42,0.10)]"
          >
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
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
    </div>
  );
}

function WorkflowBuilderCanvas() {
  return (
    <ReactFlowProvider>
      <WorkflowBuilderSurface />
    </ReactFlowProvider>
  );
}

export default WorkflowBuilderCanvas;

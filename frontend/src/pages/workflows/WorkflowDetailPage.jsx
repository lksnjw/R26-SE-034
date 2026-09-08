import { useState } from "react";
import WorkflowActions from "../../components/workflows/WorkflowActions";
import Card from "../../components/shared/ui/Card";
import WorkflowBadge from "../../components/workflows/WorkflowBadge";
import { EmptyState, ErrorState, LoadingState } from "../../components/shared/ResourceState";
import { useRoute } from "../../context/RouteContext";
import { useWorkflow } from "../../hooks/useWorkflows";
import usePermissions from "../../hooks/usePermissions";
import WorkflowAssignments from "../../components/workflows/WorkflowAssignments";
import WorkflowBuilderCanvas from "../../components/canvas/WorkflowBuilderCanvas";
import PendingApprovalCard from "../../components/executions/PendingApprovalCard";
import PendingGenerationApprovalCard from "../../components/workflows/PendingGenerationApprovalCard";
import Button from "../../components/shared/ui/Button";
import { executionService } from "../../services/execution.service";
import { Icon } from "@iconify/react";
import WorkflowSchedulePanel from "../../components/workflows/WorkflowSchedulePanel";

/*******************************************************************************
 * Function: WorkflowDetailPage
 *
 * Performs the Workflow Detail Page operation on detail page for the WorkflowDetailPage module.
 ******************************************************************************/
function WorkflowDetailPage() {
  const { selectedWorkflowId, navigateTo } = useRoute();
  const { has, actorId } = usePermissions();
	const canWrite = has("workflow:write");
  const canRun = has("workflow:run") || canWrite;
  const { data: workflow, isLoading, error, refetch } = useWorkflow(selectedWorkflowId);
  const hasPendingGenerationApproval = Boolean(workflow?.pendingGenerationApproval?.steps?.length);

  const [runState, setRunState] = useState({ loading: false, result: null, error: null });

  if (!selectedWorkflowId) return <EmptyState title="No workflow selected" description="Choose a workflow from the workflow list." />;
  if (isLoading) return <LoadingState label="Loading workflow…" />;
  if (error) return <ErrorState error={error} onRetry={refetch} />;
  if (!workflow) return <EmptyState title="Workflow not found" />;

/*******************************************************************************
 * Function: handleRun
 *
 * Handles run for the WorkflowDetailPage module.
 ******************************************************************************/
  const handleRun = async () => {
    setRunState({ loading: true, result: null, error: null });
    try {
      const execution = await executionService.run(workflow.id, {});
      setRunState({ loading: false, result: execution, error: null });
      refetch();
    } catch (err) {
      setRunState({ loading: false, result: null, error: err?.response?.data?.message || "Execution failed." });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <button type="button" onClick={() => navigateTo("workflows", "list")} className="mb-3 text-sm font-semibold text-primary">← All workflows</button>
          <h1 className="page-heading text-gray-950 dark:text-white">{workflow.name}</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-500 dark:text-gray-400">{workflow.description}</p>
        </div>
        <div className="flex flex-wrap gap-3">
          {canRun ? (
            <Button
              variant="primary"
              onClick={handleRun}
              disabled={runState.loading || hasPendingGenerationApproval}
              title={hasPendingGenerationApproval ? "Resolve the pending approval below before running" : undefined}
            >
              {runState.loading ? (
                <span className="flex items-center gap-2">
                  <Icon icon="mdi:loading" className="h-4 w-4 animate-spin" />
                  Running…
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Icon icon="mdi:play" className="h-4 w-4" />
                  Run Workflow
                </span>
              )}
            </Button>
          ) : null}
          {canWrite ? <Button variant="secondary" onClick={() => navigateTo("workflows", "builder")}>Edit in builder</Button> : null}
          <WorkflowActions workflow={workflow} onChanged={refetch} />
        </div>
      </div>

      {hasPendingGenerationApproval && (
        <PendingGenerationApprovalCard
          pending={{ workflowId: workflow.id, steps: workflow.pendingGenerationApproval.steps }}
          onResolved={refetch}
        />
      )}

      {/* Run result banner */}
      {runState.result && runState.result.status === "AWAITING_APPROVAL" && (
        <PendingApprovalCard
          execution={runState.result}
          onChanged={async () => {
            const fresh = await executionService.get(runState.result.id);
            setRunState({ loading: false, result: fresh, error: null });
            refetch();
          }}
        />
      )}
      {runState.result && runState.result.status !== "AWAITING_APPROVAL" && (
        <div className={`flex items-start gap-3 rounded-xl border p-4 ${runState.result.status === "DONE" ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}>
          <Icon
            icon={runState.result.status === "DONE" ? "mdi:check-circle" : "mdi:alert-circle"}
            className={`mt-0.5 h-5 w-5 shrink-0 ${runState.result.status === "DONE" ? "text-emerald-600" : "text-red-600"}`}
          />
          <div className="min-w-0 flex-1">
            <p className={`text-sm font-bold ${runState.result.status === "DONE" ? "text-emerald-800" : "text-red-800"}`}>
              Execution {runState.result.status === "DONE" ? "completed" : "failed"} · {runState.result.id}
            </p>
            <p className="mt-0.5 text-xs text-gray-500">{runState.result.duration} · {runState.result.tokens} tokens</p>
            {runState.result.finalOutput && (
              <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-slate-900 p-2 text-[10px] leading-4 text-green-300">
                {JSON.stringify(runState.result.finalOutput, null, 2)}
              </pre>
            )}
          </div>
          <button type="button" onClick={() => setRunState({ loading: false, result: null, error: null })} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>
      )}
      {runState.error && (
        <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <Icon icon="mdi:alert-circle" className="h-5 w-5 shrink-0" />
          {runState.error}
          <button type="button" onClick={() => setRunState({ loading: false, result: null, error: null })} className="ml-auto text-red-400 hover:text-red-600">✕</button>
        </div>
      )}

      <Card>
        <div className="grid gap-4 md:grid-cols-4">
          <div><p className="text-xs font-bold uppercase text-gray-500">Owner</p><p className="mt-2 font-semibold text-gray-950 dark:text-white">{workflow.owner}</p></div>
          <div><p className="text-xs font-bold uppercase text-gray-500">Status</p><div className="mt-2"><WorkflowBadge status={workflow.status} /></div></div>
          <div><p className="text-xs font-bold uppercase text-gray-500">Steps</p><p className="mt-2 font-semibold text-gray-950 dark:text-white">{workflow.steps}</p></div>
          <div><p className="text-xs font-bold uppercase text-gray-500">Last Run</p><p className="mt-2 font-semibold text-gray-950 dark:text-white">{workflow.lastRun || "—"}</p></div>
        </div>
      </Card>

      {/* Schedule section — keyed by workflow id so its local edit state resets to
          the freshly-loaded trigger whenever the user switches or reloads a workflow. */}
      {canWrite ? <WorkflowSchedulePanel key={workflow.id} workflow={workflow} actorId={actorId} /> : null}

      {canWrite ? <WorkflowAssignments workflow={workflow} onChanged={refetch} /> : null}
      {!canWrite ? (
        <section>
          <div className="mb-3"><h2 className="section-title">Workflow preview</h2><p className="mt-1 text-sm text-gray-500">This canvas is read-only for your role.</p></div>
          <WorkflowBuilderCanvas workflowId={workflow.id} readOnly embedded />
        </section>
      ) : null}
    </div>
  );
}

export default WorkflowDetailPage;

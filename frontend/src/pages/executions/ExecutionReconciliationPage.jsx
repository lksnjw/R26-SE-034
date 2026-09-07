import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import OperationReconciliationReview from "../../components/executions/OperationReconciliationReview";
import { executionService } from "../../services/execution.service";
import { ErrorState, LoadingState } from "../../components/shared/ResourceState";
import usePermissions from "../../hooks/usePermissions";

export default function ExecutionReconciliationPage({ executionId }) {
  const { hasAny } = usePermissions(), canUseWorkspace = hasAny(["chat:use", "workflow:write"]);
  const query = useQuery({ queryKey: ["execution-reconciliation", executionId], queryFn: () => executionService.getReconciliation(executionId), retry: false, refetchOnWindowFocus: false });
  const reload = async () => { const result = await query.refetch(); if (result.error) throw result.error; return result.data; };
  if (query.isLoading) return <LoadingState label="Loading exact uncertain-operation evidence…" />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => { void reload().catch(() => {}); }} />;
  if (!query.data) return null;
  const review = query.data.operationReconciliation;
  return <div className="max-w-3xl space-y-5"><Link className="text-sm font-semibold text-primary dark:text-violet-300" to={canUseWorkspace ? "/chat" : "/company"}>{canUseWorkspace ? "← Workspace" : "← Company"}</Link>
    <OperationReconciliationReview key={`${executionId}:${review.intentId}:${review.version}:${review.factsHash}`} execution={query.data} onReload={reload} />
  </div>;
}

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import ReportPageResolutionReview from "../../components/executions/ReportPageResolutionReview";
import { executionService } from "../../services/execution.service";
import { ErrorState, LoadingState } from "../../components/shared/ResourceState";
import usePermissions from "../../hooks/usePermissions";

export default function ExecutionReportPageResolutionPage({ executionId }) {
  const { hasAny } = usePermissions(), canUseInbox = hasAny(["execution:approve", "execution:reconcile"]), canUseWorkspace = hasAny(["chat:use", "workflow:write"]);
  const query = useQuery({ queryKey: ["report-page-resolution", executionId], queryFn: () => executionService.getReportPageResolution(executionId), retry: false, refetchOnWindowFocus: false });
  const reload = async () => { const result = await query.refetch(); if (result.error) throw result.error; return result.data; };
  if (query.isLoading) return <LoadingState label="Loading exact report-page evidence…" />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => { void reload().catch(() => {}); }} />;
  if (!query.data) return null;
  const review = query.data.reportPageResolution;
  return <div className="max-w-3xl space-y-5"><Link className="text-sm font-semibold text-primary dark:text-violet-300" to={canUseInbox ? "/executions/reviews" : canUseWorkspace ? "/chat" : "/company"}>{canUseInbox ? "← Review inbox" : canUseWorkspace ? "← Workspace" : "← Company"}</Link>
    <ReportPageResolutionReview key={`${executionId}:${review.intentId}:${review.version}:${review.factsHash}`} execution={query.data} onReload={reload} />
  </div>;
}

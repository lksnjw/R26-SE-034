import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import RuntimeApprovalReview from "../../components/executions/RuntimeApprovalReview";
import { executionService } from "../../services/execution.service";
import { ErrorState, LoadingState } from "../../components/shared/ResourceState";
import usePermissions from "../../hooks/usePermissions";

export default function ExecutionApprovalReviewPage({ executionId, approvalId }) {
  const { hasAny } = usePermissions();
  const canUseWorkspace = hasAny(["chat:use", "workflow:write"]);
  const canUseInbox = hasAny(["execution:approve", "execution:reconcile"]);
  const query = useQuery({ queryKey: ["execution-approval", executionId, approvalId], queryFn: () => approvalId ? executionService.getApproval(executionId, approvalId) : executionService.getApproval(executionId), retry: false, refetchOnWindowFocus: false });
  const reload = async () => { const result = await query.refetch(); if (result.error) throw result.error; return result.data; };
  if (query.isLoading) return <LoadingState label="Loading exact transaction review…" />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => { void reload().catch(() => {}); }} />;
  if (!query.data) return null;
  const review = query.data.runtimeApproval;
  return <div className="max-w-3xl space-y-5"><Link className="text-sm font-semibold text-primary dark:text-violet-300" to={canUseInbox ? "/executions/reviews" : canUseWorkspace ? "/chat" : "/company"}>{canUseInbox ? "← Review inbox" : canUseWorkspace ? "← Workspace" : "← Company"}</Link>
    <RuntimeApprovalReview key={`${executionId}:${review.id}:${review.version}:${review.reviewHash}`} execution={query.data} onReload={reload} />
    {canUseInbox && canUseWorkspace ? <Link className="inline-flex min-h-10 items-center text-sm font-semibold text-primary dark:text-violet-300" to="/chat">← Workspace</Link> : null}
  </div>;
}

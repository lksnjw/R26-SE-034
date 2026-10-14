import { useQuery } from "@tanstack/react-query";
import { executionService } from "../services/execution.service";
import { useExecutionMonitor } from "./useExecutionMonitor";
import { isActiveExecution } from "../utils/executionEvents";

/*******************************************************************************
 * Function: useExecution
 *
 * Provides execution for the useExecution module.
 ******************************************************************************/
export function useExecution(executionId, params = {}) {
  const monitor = useExecutionMonitor(executionId);
/*******************************************************************************
 * Function: listQuery
 *
 * Lists query for the useExecution module.
 ******************************************************************************/
  const listQuery = useQuery({
    queryKey: ["executions", params],
    queryFn: () => executionService.list(params),
    enabled: !executionId,
    refetchInterval: (query) => query.state.data?.some((item) => isActiveExecution(item.status)) ? 3000 : false,
  });
/*******************************************************************************
 * Function: detailQuery
 *
 * Performs the detail Query operation on query for the useExecution module.
 ******************************************************************************/
  const executions = listQuery.data || [];
  const selectedId = executionId || executions[0]?.id;
/*******************************************************************************
 * Function: logsQuery
 *
 * Performs the logs Query operation on query for the useExecution module.
 ******************************************************************************/
  const logsQuery = useQuery({
    queryKey: ["execution-logs", selectedId, executionId ? monitor.cursor : 0],
    queryFn: () => executionService.getLogs(selectedId),
    enabled: Boolean(selectedId) && !monitor.denied,
  });
/*******************************************************************************
 * Function: timelineQuery
 *
 * Performs the timeline Query operation on query for the useExecution module.
 ******************************************************************************/
  const timelineQuery = useQuery({
    queryKey: ["execution-timeline", selectedId],
    queryFn: () => executionService.getTimeline(selectedId),
    enabled: Boolean(selectedId) && !executionId,
  });
/*******************************************************************************
 * Function: healingQuery
 *
 * Performs the healing Query operation on query for the useExecution module.
 ******************************************************************************/
  const healingQuery = useQuery({
    queryKey: ["execution-healing", selectedId, executionId ? monitor.cursor : 0],
    queryFn: () => executionService.getHealingReport(selectedId),
    enabled: Boolean(selectedId) && !monitor.denied,
  });
  return {
    executions,
    execution: monitor.execution,
    monitor,
    selectedId,
    logs: logsQuery.data || [],
    timeline: executionId ? monitor.timeline : timelineQuery.data || [],
    healingReport: healingQuery.data || null,
    loading: executionId
      ? (!monitor.execution && !monitor.error) || logsQuery.isLoading || healingQuery.isLoading
      : listQuery.isLoading,
    error: executionId
      ? ((!monitor.execution || monitor.denied) && monitor.error ? new Error(monitor.error) : null) || logsQuery.error || healingQuery.error
      : listQuery.error,
    reload: () =>
      executionId
        ? Promise.all([monitor.refresh(), logsQuery.refetch(), healingQuery.refetch()])
        : listQuery.refetch(),
  };
}

export default useExecution;

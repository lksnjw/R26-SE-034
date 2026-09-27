import type { HandlerServices } from "../http/handlers/common.js";
import { operationJobQueue } from "./operation-jobs.js";
import { workflowScheduleRunner } from "./workflow-schedules.js";
import { withWorkflowLifecycleScope } from "./workflow-lifecycle-host.js";

/** Cron delivers denial/admission work only. Expiry never approves or sends;
 * admission records the immutable occurrence and original task outbox. */
export function advanceWorkflowLifecycle(services: HandlerServices,
  options: Parameters<typeof withWorkflowLifecycleScope>[1] = {}) {
  return withWorkflowLifecycleScope(services.repository, options, async scope => {
    const expired = await operationJobQueue(services).expireWaitingApprovalInvocation(scope);
    const occurrences = await workflowScheduleRunner(services).runDueInvocation(scope);
    return { profile: "workflow-lifecycle-result/v1", expired, ...occurrences, toolsDispatched: false };
  });
}

import type { RepositoryState } from "../repository/store.js";
import type { CurrentUser } from "../http/handlers/common.js";
import { assertChatAuthority } from "../http/handlers/model-selection.js";
import { canReadExecution } from "../http/execution-scope.js";
import { permittedWorkflow } from "../workflows/commands.js";

export type ChatWorkspaceStatus = {
  profile: "chat-workspace-status/v1";
  sampledAt: string;
  workflows: Array<{ id: string; draftVersion: number; publishedVersion: number;
    latestRun: { id: string; status: string; publishedVersion: number | null } | null }>;
};
const safeId = (value: string) => /^[A-Za-z0-9_-]{1,128}$/.test(value);
const version = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const runStatuses = new Set(["PENDING", "RUNNING", "AWAITING_APPROVAL", "DONE", "FAILED", "UNKNOWN", "CANCELLED", "REJECTED", "EXPIRED"]);
const time = (value: string) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;

/** Bounded saved facts, not a tool capability or an execution permit. Never
 * project YAML, descriptions, inputs, outputs, approvals or private journals. */
export function chatWorkspaceStatus(state: Readonly<RepositoryState>, user: CurrentUser, sessionId: string): ChatWorkspaceStatus {
  assertChatAuthority(state, user, sessionId);
  const workflows = Object.values(state.workflows)
    .filter(workflow => workflow.chatSessionId === sessionId && permittedWorkflow(workflow, user, false) &&
      safeId(workflow.id) && version(workflow.draftVersion) && version(workflow.publishedVersion))
    .sort((a, b) => time(b.updatedAt) - time(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, 5)
    .map(workflow => {
      const latest = Object.values(state.executions)
        .filter(run => run.workflowId === workflow.id && safeId(run.id) && canReadExecution(user, run))
        .sort((a, b) => time(b.startedAt) - time(a.startedAt) || a.id.localeCompare(b.id))[0];
      return { id: workflow.id, draftVersion: workflow.draftVersion, publishedVersion: workflow.publishedVersion,
        latestRun: latest ? { id: latest.id, status: runStatuses.has(latest.status) ? latest.status : "UNKNOWN",
          publishedVersion: version(latest.workflowSnapshot?.version) ? latest.workflowSnapshot!.version : null } : null };
    });
  return { profile: "chat-workspace-status/v1", sampledAt: new Date().toISOString(), workflows };
}

/** Re-sample inside the answer commit: a model wait must not freeze the
 * visible workflow state. Preserve the model text as interpretation and add
 * a separately labelled server-owned snapshot; never infer delivery from DONE. */
export function workspaceStatusAnswer(state: Readonly<RepositoryState>, user: CurrentUser, sessionId: string,
  text: string, artifacts: Record<string, unknown>) {
  const workspaceStatus = chatWorkspaceStatus(state, user, sessionId);
  if (!workspaceStatus.workflows.length) return { text, artifacts };
  const rows = workspaceStatus.workflows.map(workflow => {
    const publication = workflow.publishedVersion > 0 ? `published v${workflow.publishedVersion}` : "not published";
    const run = workflow.latestRun ? `latest recorded run ${workflow.latestRun.id}: ${workflow.latestRun.status}` +
      (workflow.latestRun.publishedVersion === null ? " (version not recorded)" : ` (published v${workflow.latestRun.publishedVersion})`) : "no recorded run";
    return `- Workflow ${workflow.id}: draft v${workflow.draftVersion}; ${publication}; ${run}.`;
  });
  return { text: `${text}\n\n**Saved workflow state — server record**\n\n${rows.join("\n")}\n\nSnapshot at ${workspaceStatus.sampledAt}. This saved state takes precedence over historical chat or model descriptions. A completed run alone is not proof of email delivery.`,
    artifacts: { ...artifacts, workspaceStatus } };
}

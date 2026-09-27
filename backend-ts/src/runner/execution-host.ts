import type { Repository } from "../repository/store.js";
import { HandlerFailure } from "../http/handlers/common.js";

export type ExecutionHostMode = "resident-server" | "bounded-invocation";

// Composition authority, not request data, persisted configuration or a model
// option. One repository owner cannot be reused under a different host policy.
const hosts = new WeakMap<Repository, ExecutionHostMode>();

export function bindExecutionHost(repository: Repository, mode?: ExecutionHostMode): ExecutionHostMode {
  if (mode !== undefined && mode !== "resident-server" && mode !== "bounded-invocation")
    throw new Error("Unsupported execution host policy");
  const previous = hosts.get(repository), selected = mode ?? previous ?? "resident-server";
  if (previous !== undefined && previous !== selected)
    throw new Error("Repository execution host policy cannot change after ownership is bound");
  hosts.set(repository, selected);
  return selected;
}

export function residentExecutionAllowed(repository: Repository): boolean {
  return bindExecutionHost(repository) === "resident-server";
}

/** Transitional gate for paths without an installed bounded task protocol.
 * Read jobs have their own explicit outbox admission; other job/resume paths
 * must refuse BEFORE saving work, rather than strand apparently accepted jobs.
 * This does not certify a bounded host as an executable deployment. */
export function requireResidentExecution(repository: Repository): void {
  if (!residentExecutionAllowed(repository)) throw new HandlerFailure(503,
    "Durable task dispatch is not connected for this bounded host. No new job or continuation was admitted. Use the resident server until the Functions task adapter is qualified.",
    { code: "EXECUTION_HOST_DISPATCH_UNAVAILABLE" });
}

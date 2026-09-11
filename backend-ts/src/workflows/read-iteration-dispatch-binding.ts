import type { HandlerServices } from "../http/handlers/common.js";
import type { RepositoryState } from "../repository/store.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { captureReadAdmissionPin } from "../registry/capability-admission.js";
import { assertCompiledReadMatches, compileReadWorkflow, readCompilationReceipt, type CompiledReadPlan, type ReadAdmissionPin } from "./compiled-read.js";
import type { StoredReadCompilation } from "./read-compilation-lifecycle.js";
import { loopNodes } from "./read-control-flow.js";
import { boundMcpConnection, connectionToolKey } from "../tools/mcp-dispatch-context.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";

/** Denial-only runtime binding for the admitted collection execution profile.
 * This does NOT create a publication, run, capability or worker lease. */
export function assertIterationDispatchBinding(services: HandlerServices, state: Readonly<RepositoryState>, executionId: string, epoch: number,
  yaml: string, expected: CompiledReadPlan, role: string): void {
  const item = state.executions[executionId], snapshot = item?.workflowSnapshot;
  if (!item || item.status !== "RUNNING" || item.readProgress?.epoch !== epoch || !snapshot || snapshot.executionProfile !== "collection-read-v1" ||
      snapshot.yaml !== yaml || snapshot.contentHash !== expected.sourceHash || snapshot.registryHash !== services.registries.hash() ||
      expected.ir.schemaVersion !== "workflow-read-ir/v4" || !expected.ir.flow || !loopNodes(expected.ir.flow).length)
    throw new Error("Collection execution has no current reviewed SDK-entry binding");
  const publication = (state.versions[item.workflowId] ?? []).findLast(version => version.version === snapshot.version && version.artifactState === "PUBLISHED");
  const stored = publication?.compiledRead as StoredReadCompilation | undefined;
  if (publication?.yaml !== yaml || !stored || canonicalJSONBytes(stored).length > 1_200_000 || !Number.isFinite(Date.parse(stored.compiledAt)))
    throw new Error("Pinned collection publication is missing or malformed");
  const tools = services.registries.snapshot().tools, pins = new Map<string, ReadAdmissionPin>(), source = parseWorkflowYAMLStrict(yaml);
  for (let index = 0; index < expected.ir.root.nodes.length; index++) {
    const node = expected.ir.root.nodes[index]!, step = source.steps[index]!;
    const pin = node.capability.admission, matches = tools.filter(tool => tool.tool_id === node.capability.toolId);
    if (!pin || matches.length !== 1) throw new Error("Collection action requires an exact reviewed capability revision");
    const session = boundMcpConnection(services, pin.connectionId).session;
    if (session.available === false || session.requiresReviewedRevision !== true || session.dispatchBoundary !== "sdk-entry/v1" || !session.admissionBinding)
      throw new Error("Collection action connection is unavailable");
    const captured = captureReadAdmissionPin(state, services.registries, matches[0]!, session.admissionBinding, pin, pin.connectionId);
    pins.set(connectionToolKey(pin.connectionId, node.capability.toolId), captured); if (!step.connection_id) pins.set(node.capability.toolId, captured);
  }
  const current = compileReadWorkflow(yaml, tools, role, pins);
  assertCompiledReadMatches(expected, current); assertCompiledReadMatches(stored.plan, current);
  const receipt = readCompilationReceipt(current, services.registries.hash(), "PUBLICATION", "reviewed");
  if (!canonicalJSONBytes(receipt).equals(canonicalJSONBytes(stored.receipt)) || !canonicalJSONBytes(receipt).equals(canonicalJSONBytes(snapshot.compilation)))
    throw new Error("Collection publication or execution compilation receipt changed");
}

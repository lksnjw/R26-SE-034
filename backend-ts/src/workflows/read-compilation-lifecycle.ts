import type { HandlerServices, CurrentUser } from "../http/handlers/common.js";
import { HandlerFailure } from "../http/handlers/common.js";
import type { RepositoryState, StoredRecord } from "../repository/store.js";
import { captureReadAdmissionPin } from "../registry/capability-admission.js";
import { discoverTools } from "../agent/tool-discovery.js";
import { buildReadIR, compileReadWorkflow, assertCompiledReadMatches, readCompilationReceipt, type CompiledReadPlan, type ReadAdmissionPin, type ReadCompilationReceipt } from "./compiled-read.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import type { ErpbridgeMcpSession } from "../tools/erpbridge-mcp-client.js";
import { supportsCollectionReads } from "../runner/read-collection-admission.js";

export type StoredReadCompilation = { plan: CompiledReadPlan; receipt: ReadCompilationReceipt; verifiedRole: string; compiledAt: string };
export type PreparedReadCompilation = { stored: StoredReadCompilation; session: ErpbridgeMcpSession | undefined; generation: number };

export async function prepareReadPublication(services: HandlerServices, yaml: string, user: CurrentUser): Promise<PreparedReadCompilation | null> {
  const tools = services.registries.snapshot().tools, built = buildReadIR(parseWorkflowYAMLStrict(yaml), tools, user.role);
  if (built.issues.length || built.ir.schemaVersion === "workflow-read-ir/v4" && !supportsCollectionReads(services)) return null;
  const registryHash = services.registries.hash(), session = services.erpbridgeSession, generation = session?.discoveryGeneration ?? 0;
  const pins = new Map<string, ReadAdmissionPin>();
  if (session?.requiresReviewedRevision || services.config.mcpTransport === "erpbridge-mcp" && services.config.mcpMode === "remote") {
    if (!session || session.available === false || !session.admissionBinding) throw new HandlerFailure(503, "Connected reviewed ERPBridge is required to compile this publication", { code: "COMPILATION_CONNECTION_REQUIRED" });
    let live; try { live = await discoverTools(session, services.registries); } catch { throw new HandlerFailure(503, "Discovery could not confirm publication contracts", { code: "COMPILATION_DISCOVERY_FAILED" }); }
    if (buildReadIR(parseWorkflowYAMLStrict(yaml), live, user.role).issues.length) throw new HandlerFailure(422, "Exact reviewed live contracts are required to compile this publication", { code: "COMPILATION_ADMISSION_REQUIRED" });
    try { await services.repository.readAuthoritative(state => { for (const toolId of new Set(built.ir.root.nodes.map(node => node.capability.toolId))) {
      const tool = tools.find(value => value.tool_id === toolId)!; pins.set(toolId, captureReadAdmissionPin(state, services.registries, tool, session.admissionBinding!));
    } }); } catch { throw new HandlerFailure(409, "Capability review changed during compilation", { code: "COMPILATION_ADMISSION_CHANGED" }); }
  }
  if (registryHash !== services.registries.hash() || services.erpbridgeSession !== session || session?.available === false || generation !== (session?.discoveryGeneration ?? 0))
    throw new HandlerFailure(409, "Compilation connection or registry changed", { code: "COMPILATION_CONTEXT_CHANGED" });
  const plan = compileReadWorkflow(yaml, tools, user.role, pins);
  return { stored: { plan, receipt: readCompilationReceipt(plan, registryHash, "PUBLICATION", pins.size ? "reviewed" : "fixture-legacy"), verifiedRole: user.role, compiledAt: new Date().toISOString() }, session, generation };
}

/** Called inside the publication transaction after awaited validation. It
 * checks current grants/pins again but never performs network work. */
export function assertReadPublicationCurrent(prepared: PreparedReadCompilation, services: HandlerServices, state: Readonly<RepositoryState>, yaml: string, role: string) {
  const { stored, session, generation } = prepared;
  if (stored.receipt.registryHash !== services.registries.hash() || services.erpbridgeSession !== session || session?.available === false || generation !== (session?.discoveryGeneration ?? 0))
    throw new HandlerFailure(409, "Compilation context changed before publication", { code: "COMPILATION_CONTEXT_CHANGED" });
  try { assertCompiledReadMatches(stored.plan, compileCurrent(state, services, yaml, role, stored.plan)); }
  catch { throw new HandlerFailure(409, "Compiled source or capability admission changed before publication", { code: "COMPILATION_ADMISSION_CHANGED" }); }
}

/** Modern historical YAML-only publications require explicit re-publication;
 * never manufacture reviewed evidence on GET/run/restart. Injected legacy
 * fixtures may compile at preflight, explicitly labelled as such. */
export function prepareCompiledExecution(state: Readonly<RepositoryState>, services: HandlerServices, publication: StoredRecord, yaml: string, role: string,
  expectedReceipt?: ReadCompilationReceipt): { plan: CompiledReadPlan; receipt: ReadCompilationReceipt } {
  try {
    const raw = publication.compiledRead as StoredReadCompilation | undefined;
    if (!raw) {
      if (services.erpbridgeSession?.requiresReviewedRevision || services.config.mcpTransport === "erpbridge-mcp" && services.config.mcpMode === "remote")
        throw new Error("Modern publication has no reviewed compilation");
      const plan = compileReadWorkflow(yaml, services.registries.snapshot().tools, role), receipt = readCompilationReceipt(plan, services.registries.hash(), "LEGACY_PREFLIGHT", "fixture-legacy");
      if (plan.ir.schemaVersion === "workflow-read-ir/v4") throw new Error("Collection executable admission is not qualified");
      if (expectedReceipt && !canonicalJSONBytes(expectedReceipt).equals(canonicalJSONBytes(receipt))) throw new Error("Legacy compilation changed");
      return { plan, receipt };
    }
    if (canonicalJSONBytes(raw).length > 1_200_000 || !Number.isFinite(Date.parse(raw.compiledAt)) || raw.receipt.origin !== "PUBLICATION" ||
        raw.receipt.registryHash !== services.registries.hash()) throw new Error("Stored compilation is malformed or stale");
    const plan = compileCurrent(state, services, yaml, role, raw.plan);
    if (plan.ir.schemaVersion === "workflow-read-ir/v4" && (!supportsCollectionReads(services) || raw.receipt.admissionMode !== "reviewed")) throw new Error("Collection executable admission is not qualified");
    assertCompiledReadMatches(raw.plan, plan);
    const receipt = readCompilationReceipt(plan, services.registries.hash(), "PUBLICATION", plan.ir.root.nodes.some(node => node.capability.admission) ? "reviewed" : "fixture-legacy");
    if (!canonicalJSONBytes(raw.receipt).equals(canonicalJSONBytes(receipt)) || expectedReceipt && !canonicalJSONBytes(expectedReceipt).equals(canonicalJSONBytes(receipt))) throw new Error("Stored compilation receipt changed");
    return { plan, receipt };
  } catch { throw new HandlerFailure(409, "Publication compilation is missing, changed or no longer admitted. Review and explicitly republish before execution", { code: "PUBLISHED_COMPILATION_REQUIRED" }); }
}

function compileCurrent(state: Readonly<RepositoryState>, services: HandlerServices, yaml: string, role: string, expected: CompiledReadPlan): CompiledReadPlan {
  const tools = services.registries.snapshot().tools, pins = new Map<string, ReadAdmissionPin>(), modern = services.erpbridgeSession?.requiresReviewedRevision === true || services.config.mcpTransport === "erpbridge-mcp" && services.config.mcpMode === "remote";
  for (const node of expected.ir.root.nodes) {
    if (modern && !node.capability.admission) throw new Error("Compiled node has no admission pin");
    if (node.capability.admission) {
      const tool = tools.find(value => value.tool_id === node.capability.toolId);
      if (!tool || services.erpbridgeSession?.available === false || !services.erpbridgeSession?.admissionBinding) throw new Error("Compiled connection unavailable");
      pins.set(tool.tool_id, captureReadAdmissionPin(state, services.registries, tool, services.erpbridgeSession.admissionBinding, node.capability.admission));
    }
  }
  return compileReadWorkflow(yaml, tools, role, pins);
}

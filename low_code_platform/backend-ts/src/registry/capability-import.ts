import { createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyRequest } from "fastify";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import type { Repository, RepositoryState } from "../repository/store.js";
import type { ErpbridgeMcpSession } from "../tools/erpbridge-mcp-client.js";
import { exactBridgeName } from "../tools/erpbridge-contract.js";
import { toolSchema, type ToolDefinition } from "./schemas.js";
import type { RegistryService } from "./service.js";
import { discoveredContract, discoveredToolIdentity, remoteContractHash } from "./discovered-contract.js";
import { activeBinding, administrator, admissionSchema, capabilityContractHash, capabilityIdFor, DEFAULT_BRIDGE_CONNECTION,
  observationSchema, publicRevision, requireAdmissionStorage, revisionSchema, supportedOperation, supportedRead } from "./capability-admission.js";
import { appendAudit, HandlerFailure, nextID, now, type CurrentUser } from "../http/handlers/common.js";
import { modelDataClasses } from "../providers/egress-policy.js";

const fields = { remoteName: z.string().min(1).max(256), remoteHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  decisionKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/), allowedRoles: z.array(z.string().trim().min(1).max(128)).min(1).max(32).refine(roles => new Set(roles).size === roles.length),
  retryPolicy: z.literal("never"), note: z.string().trim().min(1).max(2000), confirmed: z.literal(true) };
export const importCapabilitySchema = z.discriminatedUnion("effectClass", [
  z.object({ ...fields, effectClass: z.literal("read"), riskClass: z.literal("low"), dataClass: z.enum(modelDataClasses) }).strict(),
  ...["write", "notification"].map(effectClass => z.object({ ...fields, effectClass: z.literal(effectClass), riskClass: z.enum(["low", "medium"]),
    dataClass: z.enum(["internal", "confidential"]), sideEffects: z.array(z.string().trim().min(1).max(256)).min(1).max(32),
    operationContract: toolSchema.shape.operation_contract.unwrap(), requireIndependentApproval: z.literal(true) }).strict()),
]);
const digest = (value: unknown) => `sha256:${createHash("sha256").update(canonicalJSONBytes(value)).digest("hex")}`;

/** Only current reviewed capability records contribute to the catalog. A
 * disabled definition stays known but its admission stays disabled. No files,
 * remote calls, automatic re-review or role grants are performed here. */
export function importedDefinitions(state: Readonly<RepositoryState>): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  for (const raw of Object.values(state.capabilityAdmissions)) {
    const admission = admissionSchema.parse(raw), revision = revisionSchema.parse(state.capabilityRevisions[admission.revisionId]);
    const tool = revision.definition;
    if (revision.definitionSource !== "discovered-contract/v1") continue;
    const identity = discoveredToolIdentity(revision.connectionId, tool.mcp_tool_name);
    if (admission.capabilityId !== revision.capabilityId || revision.capabilityId !== capabilityIdFor(revision.connectionId, tool.tool_id) ||
        tool.connection_id !== revision.connectionId || tool.tool_id !== identity.tool_id || tool.name !== identity.name || capabilityContractHash(tool) !== revision.contractHash)
      throw new Error("Persisted discovered capability identity/contract is inconsistent");
    if (tool.is_read_only) { supportedRead(tool); if (revision.policy.effectClass !== "read") throw new Error("Persisted read policy is inconsistent"); }
    else { supportedOperation(tool); if (revision.policy.effectClass !== tool.operation_contract?.effect_class || revision.policy.riskClass !== tool.risk_level.toLowerCase()) throw new Error("Persisted operation policy is inconsistent"); }
    tools.push(tool);
  }
  return tools;
}

export async function restoreImportedCapabilities(repository: Repository, registries: RegistryService): Promise<void> {
  await repository.readAuthoritative(state => registries.replaceReviewedTools(importedDefinitions(state)));
}

/** One explicit admin decision atomically persists observation, immutable
 * reviewed definition and admission. Discovery itself never calls this path. */
export async function importDiscoveredCapability(input: { repository: Repository; registries: RegistryService; session: ErpbridgeMcpSession | undefined;
  user: CurrentUser; connectionId?: string; body: unknown; signal?: AbortSignal; request?: FastifyRequest }) {
  const { repository, registries, session, user } = input;
  requireAdmissionStorage(repository);
  await repository.readAuthoritative(state => administrator(state, user));
  const parsed = importCapabilitySchema.safeParse(input.body);
  if (!parsed.success) throw new HandlerFailure(400, "Explicit discovered-tool review requires current fingerprint, role grants, effect/data/risk policy, confirmation and a stable decision key");
  const body = parsed.data, connectionId = input.connectionId ?? DEFAULT_BRIDGE_CONNECTION;
  const connectionBinding = activeBinding(session), generation = session!.discoveryGeneration ?? 0, registryHash = registries.hash();
  if (session!.connectionId && session!.connectionId !== connectionId) throw new HandlerFailure(409, "The selected session belongs to another connection");
  const remote = await session!.listTools(input.signal);
  if (remote.length > 2048 || canonicalJSONBytes(remote).length > 2000000 || new Set(remote.map(tool => tool.name)).size !== remote.length)
    throw new HandlerFailure(409, "Discovery is incomplete or exceeds the review budget");
  const selected = remote.filter(tool => tool.name === body.remoteName);
  if (selected.length !== 1 || remoteContractHash(selected[0]!) !== body.remoteHash) throw new HandlerFailure(409, "Remote contract changed; refresh discovery and review again");
  const draft = discoveredContract(selected[0]!, connectionId);
  const tool = toolSchema.parse({ ...draft, allowed_roles: body.allowedRoles, risk_level: body.riskClass, is_read_only: body.effectClass === "read",
    ...("operationContract" in body ? { operation_contract: body.operationContract, side_effects: body.sideEffects } : {}) });
  if (body.effectClass === "read") {
    if (selected[0]!.annotations?.readOnlyHint === false || selected[0]!.annotations?.destructiveHint === true)
      throw new HandlerFailure(422, "Remote effect hints conflict with the requested read attestation; review the operation contract instead");
    supportedRead(tool);
  } else {
    supportedOperation(tool);
    if (tool.operation_contract?.effect_class !== body.effectClass) throw new HandlerFailure(422, "The result contract must match the reviewed effect");
  }
  const policy = { effectClass: body.effectClass, riskClass: body.riskClass, dataClass: body.dataClass, retryPolicy: body.retryPolicy, note: body.note,
    ...(body.effectClass === "read" ? {} : { requireIndependentApproval: true }) };
  const capabilityId = capabilityIdFor(connectionId, tool.tool_id), contractHash = capabilityContractHash(tool);
  const decisionScope = digest([user.id, capabilityId, body.decisionKey]), decisionHash = digest(body);
  input.signal?.throwIfAborted();
  const saved = await repository.mutate(state => {
    input.signal?.throwIfAborted();
    administrator(state, user);
    if (registryHash !== registries.hash() || generation !== (session!.discoveryGeneration ?? 0) || activeBinding(session) !== connectionBinding)
      throw new HandlerFailure(409, "Connection/catalog changed before review commit; refresh and review again");
    const previous = Object.values(state.capabilityRevisions).find(value => value.decisionScope === decisionScope);
    if (previous) {
      const revision = revisionSchema.parse(previous);
      if (revision.decisionHash !== decisionHash) throw new HandlerFailure(409, "This decision key was used for another review");
      return { revision: publicRevision(revision), admission: admissionSchema.parse(state.capabilityAdmissions[capabilityId]), duplicate: true };
    }
    if (!body.allowedRoles.every(role => Object.values(state.roles).some(value => value.name === role))) throw new HandlerFailure(422, "Every role grant must name a current application role");
    const current = registries.snapshot().tools;
    if (current.some(value => !value.connection_id && (value.tool_id === tool.tool_id || value.name === tool.name || exactBridgeName(value) === body.remoteName)))
      throw new HandlerFailure(409, "A release contract already owns this tool; use its normal review path");
    const nextTools = importedDefinitions(state).filter(value => value.tool_id !== tool.tool_id).concat(tool);
    registries.validateReviewedTools(nextTools);
    if (nextTools.length > 512 || canonicalJSONBytes(nextTools).length > 2000000 || canonicalJSONBytes(tool).length > 65536 || Object.keys(state.capabilityObservations).length >= 10000)
      throw new HandlerFailure(413, "Persisted capability review budget reached");
    const observation = observationSchema.parse({ id: nextID(state, "capobs"), capabilityId, connectionId, connectionBinding, toolId: tool.tool_id,
      contractHash, definition: tool, discoveredAt: now(), registryHash, discoveryGeneration: generation, remoteMatches: true });
    const revision = revisionSchema.parse({ id: nextID(state, "caprev"), capabilityId, connectionId, connectionBinding, toolId: tool.tool_id,
      contractHash, definition: tool, definitionSource: "discovered-contract/v1", observationId: observation.id, reviewedAt: now(), reviewedBy: { id: user.id, role: "Platform Admin" }, decisionScope, decisionHash, policy });
    const previousAdmission = state.capabilityAdmissions[capabilityId];
    const admission = admissionSchema.parse({ capabilityId, revisionId: revision.id, state: "AVAILABLE", version: previousAdmission ? admissionSchema.parse(previousAdmission).version + 1 : 1, updatedAt: now() });
    state.capabilityObservations[observation.id] = observation; state.capabilityRevisions[revision.id] = revision; state.capabilityAdmissions[capabilityId] = admission;
    appendAudit(state, user, "capability.discovered.imported", "capability", capabilityId, previousAdmission ?? null, { revisionId: revision.id, contractHash, policy }, input.request);
    return { revision: publicRevision(revision), admission, duplicate: false };
  });
  await restoreImportedCapabilities(repository, registries);
  return { ...saved, remoteHash: body.remoteHash };
}

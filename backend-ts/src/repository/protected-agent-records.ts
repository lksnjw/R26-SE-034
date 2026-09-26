import { z } from "zod";
import { assertProviderContinuation, providerContinuationSchema } from "../analysisprovider/provider-continuation.js";
import { assertBoundedFiniteJSON } from "../core/bounded-finite-json.js";
import { canonicalJSONBytes, resolvedParameterHashBytes } from "../core/canonical-json.js";
import { withoutSecretFields } from "../redact/secrets.js";
import type { ProtectedInvocationLedgerSnapshot } from "./protected-invocation-records.js";
import { toolSchema } from "../registry/schemas.js";

const hash = (value: unknown) => resolvedParameterHashBytes(canonicalJSONBytes(value));
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/), address = z.string().min(1).max(1100);
const nodeId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const progress = z.object({ profile: z.literal("protected-agent-invocation/v1"), invocationId: address, nodeId,
  sequence: z.number().int().min(0).max(4999), pointHash: sha, inputHash: sha, nodeHash: sha,
  model: z.string().min(1).max(256), startedAt: integer, deadline: integer,
  turnCount: z.number().int().min(0).max(8), resultCount: z.number().int().min(0).max(16) }).strict();
const ownedProgress = progress.extend({ profile: z.literal("protected-agent-invocation/v2"), offers: z.array(toolSchema).min(1).max(8) }).strict();
const turn = z.object({ text: z.string(), toolCalls: z.array(z.object({ id: z.string().min(1).max(256), name: z.string().min(1).max(256),
  arguments: z.record(z.string(), z.unknown()) }).strict()).max(16), stopReason: z.string().min(1).max(64),
  inputTokens: integer, outputTokens: integer, measured: z.literal(true), model: z.string().min(1).max(256).optional(),
  provider: z.string().min(1).max(256).optional(), configurationRevision: z.string().min(1).max(256).optional(),
  providerContinuationSecret: providerContinuationSchema.superRefine((value, ctx) => {
    try { assertProviderContinuation(value); } catch { ctx.addIssue({ code: "custom", message: "Invalid private provider continuation" }); }
  }).optional() }).strict();
const modelRecord = z.object({ profile: z.literal("protected-agent-turn/v1"), invocationId: address,
  round: z.number().int().min(0).max(7), turn }).strict();
const toolRecord = z.object({ profile: z.literal("protected-agent-result/v1"), invocationId: address,
  round: z.number().int().min(0).max(7), callIndex: z.number().int().min(0).max(15), result: z.union([
    z.object({ kind: z.literal("OUTPUT"), output: z.record(z.string(), z.unknown()) }).strict(),
    z.object({ kind: z.literal("READ_ERROR"), fault: z.object({ code: z.literal("ERP_RESOURCE_NOT_FOUND"),
      failedNodeId: nodeId, failedInvocationId: address }).strict() }).strict(),
  ]) }).strict();
const schema = z.object({ profile: z.literal("protected-agent-records/v1"), invocations: z.record(address, progress),
  turns: z.record(sha, modelRecord), results: z.record(sha, toolRecord) }).strict();
const ownedSchema = schema.extend({ profile: z.literal("protected-agent-records/v2"), invocations: z.record(address, ownedProgress) }).strict();
const profiles = z.union([schema, ownedSchema]);
export type ProtectedAgentRecords = z.infer<typeof profiles>;
export type ProtectedAgentProgress = z.infer<typeof progress> | z.infer<typeof ownedProgress>;
export type ProtectedAgentTurn = z.infer<typeof modelRecord>;
export type ProtectedAgentResult = z.infer<typeof toolRecord>;

export const emptyProtectedAgentRecords = (): z.infer<typeof ownedSchema> => ({ profile: "protected-agent-records/v2", invocations: {}, turns: {}, results: {} });

/** Strict normalized private DATA. It is neither a confirmed storage commit
 * nor a provider/tool permit. The owned worker must authenticate it, replay the
 * original dialogue and prove current authority before any external entry. */
export function assertProtectedAgentRecords(value: unknown, ledger: ProtectedInvocationLedgerSnapshot): asserts value is ProtectedAgentRecords {
  assertBoundedFiniteJSON(value, 32_000_000, 2_000_000);
  const data = profiles.parse(value), sequences = new Set<number>();
  if (Object.keys(data.invocations).length > 5000 || Object.keys(data.turns).length + Object.keys(data.results).length > 20000)
    throw new Error("Protected agent records exceed invocation bounds");
  const keyFor = (invocationId: string, component: unknown) => hash({ domain: "lcwe/protected-invocation-operation/v1", identity: ledger.identity, invocationId, component });
  const counts = new Map<string, { turns: number; results: number }>();
  for (const [id, item] of Object.entries(data.invocations)) {
    assertBoundedFiniteJSON(item, 1_000_000);
    if (id !== item.invocationId || item.sequence > ledger.nextSequence || sequences.has(item.sequence) || item.deadline <= item.startedAt || item.deadline - item.startedAt > 120000)
      throw new Error("Protected agent invocation address, sequence or deadline changed");
    sequences.add(item.sequence); counts.set(id, { turns: 0, results: 0 });
    const receipt = ledger.receipts[String(item.sequence)];
    if (item.sequence < ledger.nextSequence && (!receipt || receipt.boundary.kind !== "action" || receipt.boundary.nodeId !== item.nodeId || receipt.boundary.invocationId !== id))
      throw new Error("Protected agent invocation differs from its consumed boundary");
  }
  for (const [key, row] of [...Object.entries(data.turns), ...Object.entries(data.results)]) {
    assertBoundedFiniteJSON(row, 1_000_000);
    const owner = data.invocations[row.invocationId], isModel = row.profile === "protected-agent-turn/v1";
    const component = isModel ? { kind: "agent-model", round: row.round } : { kind: "agent-tool", round: row.round, callIndex: row.callIndex };
    const intent = ledger.intents[key];
    if (!owner || key !== keyFor(row.invocationId, component) || !intent || intent.state !== "ACKNOWLEDGED" || intent.sequence !== owner.sequence ||
        intent.boundary.nodeId !== owner.nodeId || intent.boundary.invocationId !== owner.invocationId || hash(intent.component) !== hash(component) || intent.purpose !== component.kind)
      throw new Error("Protected agent artifact lacks its exact acknowledged invocation");
    if (isModel) {
      if (intent.result?.kind !== "OUTPUT") throw new Error("Protected agent model artifact is not a successful model acknowledgement");
      if (row.turn.providerContinuationSecret && (!row.turn.toolCalls.length || row.turn.providerContinuationSecret.model !== owner.model))
        throw new Error("Protected agent continuation differs from its selected model or tool round");
      let acknowledged: unknown = row.turn;
      if (!row.turn.toolCalls.length) {
        if (row.turn.stopReason !== "stop") throw new Error("Protected agent final turn has no complete stop reason");
        try { acknowledged = { structuredContent: withoutSecretFields(JSON.parse(row.turn.text)) }; }
        catch { throw new Error("Protected agent acknowledged final turn is not JSON"); }
      } else if (row.turn.stopReason !== "tool_calls") throw new Error("Protected agent tool turn has no complete stop reason");
      if (intent.result.hash !== hash(acknowledged) || row.round >= owner.turnCount || row.turn.model !== undefined && row.turn.model !== owner.model)
        throw new Error("Protected agent model artifact differs from its acknowledgement or selected model");
      counts.get(owner.invocationId)!.turns++;
    } else {
      const result = row.result;
      if (intent.result?.kind !== result.kind || intent.result.hash !== hash(result.kind === "OUTPUT" ? result.output : result.fault) ||
          result.kind === "READ_ERROR" && (result.fault.failedNodeId !== owner.nodeId || result.fault.failedInvocationId !== owner.invocationId))
        throw new Error("Protected agent tool artifact differs from its exact acknowledgement");
      counts.get(owner.invocationId)!.results++;
    }
  }
  for (const [id, item] of Object.entries(data.invocations)) {
    const count = counts.get(id)!;
    if (count.turns !== item.turnCount || count.results !== item.resultCount) throw new Error("Protected agent artifacts are missing from declared counts");
    for (let round = 0; round < item.turnCount; round++) if (!Object.hasOwn(data.turns, keyFor(id, { kind: "agent-model", round })))
      throw new Error("Protected agent model turns are missing or reordered");
  }
  for (const intent of Object.values(ledger.intents)) if (["agent-model", "agent-tool"].includes(intent.purpose)) {
    const owner = data.invocations[intent.boundary.invocationId];
    if (!owner || owner.sequence !== intent.sequence || owner.nodeId !== intent.boundary.nodeId ||
        intent.state === "ACKNOWLEDGED" && !Object.hasOwn(intent.purpose === "agent-model" ? data.turns : data.results, intent.key))
      throw new Error("Protected agent sub-call has no complete saved dialogue owner/artifact");
  }
}

import { stringify } from "yaml";
import { protectedPreparationFixture } from "./protected-preparation.js";
import { fixtureSequence as seq, fixtureAction as action, fixtureRef as ref } from "./protected-simulation.js";
import { toolSchema } from "../../src/registry/schemas.js";
import { observeCapabilities, reviewCapability } from "../../src/registry/capability-admission.js";
import { publishProtectedOperation, assertStoredProtectedOperationPublicationCurrent, type ProtectedOperationPublicationReceipt } from "../../src/workflows/protected-operation-publication.js";
import { workflowContentHash } from "../../src/parser/workflow.js";
import { ProtectedMachine } from "../../src/workflows/protected-machine.js";
import { ProtectedInvocationLedger } from "../../src/runner/protected-invocation-ledger.js";
import { protectedAdmissionSeal, protectedHash as hash, sealProtectedCursor } from "../../src/runner/protected-job-state.js";
import { newReadProgress } from "../../src/runner/read-checkpoints.js";
import type { Repository, Execution } from "../../src/repository/store.js";

export const reportStart = "2026-10-01T00:00:00.000Z", reportEnd = "2026-10-02T00:00:00.000Z";
/** TEST ONLY sealed QUEUED admission, never fabricated page/coverage evidence.
 * All SDK responses below are synthetic; owned broker/checkpoints are genuine. */
export async function protectedReportFixture(mode: "page" | "cursor" = "cursor", items = ["one"], repository?: Repository,
  configure?: (source: any) => void) {
  const s = await protectedPreparationFixture(undefined, false, repository);
  const base = s.tools[0]!, properties = { id: { type: "string" }, startAt: { type: "string" }, endAt: { type: "string" },
    ...(mode === "page" ? { page: { type: "integer" } } : { cursor: { type: "string" } }) };
  const pagination = mode === "page" ? { profile: "page-number/v1", page_parameter: "page", page_path: ["page"], first_page: 1,
    snapshot_path: ["snapshot"], total_count_path: ["total"], max_pages: 3, max_items: 20 } :
    { profile: "opaque-cursor/v1", cursor_parameter: "cursor", cursor_path: ["cursor"], next_cursor_path: ["nextCursor"], initial_cursor: "",
      snapshot_path: ["snapshot"], total_count_path: ["total"], max_pages: 3, max_items: 20 };
  const outputProperties = { startAt: { type: "string" }, endAt: { type: "string" }, complete: { type: "boolean" }, hasMore: { type: "boolean" },
    items: { type: "array", maxItems: 20, items: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
    count: { type: "integer" }, snapshot: { type: "string" }, total: { type: "integer" },
    ...(mode === "page" ? { page: { type: "integer" } } : { cursor: { type: "string" }, nextCursor: { type: "string" } }) };
  const { read_error_contract: _unused, ...readBase } = base;
  const tool = s.tools[0] = toolSchema.parse({ ...readBase, tool_id: "protected-report", name: "fixture.report", mcp_tool_name: "fixture.report",
    input_schema: { type: "object", properties, required: ["id", "startAt", "endAt"], additionalProperties: false }, required_parameters: ["id", "startAt", "endAt"],
    report_coverage_contract: { profile: "report-coverage/v1", start_parameter: "startAt", end_parameter: "endAt", covered_start_path: ["startAt"],
      covered_end_path: ["endAt"], complete_path: ["complete"], has_more_path: ["hasMore"], items_path: ["items"], item_count_path: ["count"], pagination },
    bridge_contract: { ...base.bridge_contract!, resource_digest: "e".repeat(64), output_schema: { type: "object", properties: outputProperties,
      required: Object.keys(outputProperties), additionalProperties: false } } });
  s.toolsChanged();
  const observed = (await observeCapabilities({ repository: s.repository, registries: s.registries, session: s.session, user: s.actor })).observations;
  for (const row of observed) await reviewCapability({ repository: s.repository, registries: s.registries, session: s.session, user: s.actor,
    capabilityId: row.capabilityId, body: { observationId: row.id, contractHash: row.contractHash, decisionKey: "review-protected-report-0001",
      effectClass: "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Synthetic report qualification only" } });
  s.source.steps = [{ id: "report", action: tool.name, parameters: { id: "{{each.item}}", startAt: reportStart, endAt: reportEnd } }];
  s.source.metadata.controlFlow.root = seq({ kind: "foreach", id: "each", maxItems: 3,
    items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "workflowInput", path: ["items"] } },
    body: seq(action("report")), collect: { schema: { type: "integer" }, value: ref("report", "structuredContent", "count") } },
    { kind: "return", id: "answer", output: { schema: { type: "array", items: { type: "integer" } }, value: ref("each", "value") } });
  configure?.(s.source); await s.saveSource();
  const publication = await publishProtectedOperation(s.services, "flow", s.actor, { baseVersion: 1, baseHash: workflowContentHash(stringify(s.source)) });
  const runId = "test-only-protected-report";
  await s.repository.mutate(state => {
    const version = state.versions.flow!.find(row => row.id === publication.id)!;
    const receipt = structuredClone(version.protectedCompilation) as ProtectedOperationPublicationReceipt;
    const plan = assertStoredProtectedOperationPublicationCurrent(state, s.services, String(version.id), "flow", s.actor.role), input = { items };
    const machine = new ProtectedMachine(plan.machine, input); machine.peek();
    const ledger = new ProtectedInvocationLedger({ executionId: runId, workflowId: "flow", actorId: s.actor.id, roleId: s.actor.roleId, admittedRole: s.actor.role,
      sourceHash: plan.sourceHash, operationHash: plan.semanticHash, machineHash: plan.machine.semanticHash, inputHash: hash(input) }, plan.machine, machine);
    const createdAt = new Date().toISOString(), run: Execution = { id: runId, workflowId: "flow", workflowName: "Private protected report", status: "PENDING",
      startedBy: { id: s.actor.id, name: s.actor.name }, startedAt: createdAt, completedAt: null, durationMs: 0, costUsd: 0, tokens: { input: 0, output: 0, total: 0 },
      stepOutputs: {}, readProgress: newReadProgress(s.repository), workflowSnapshot: { yaml: version.yaml as string, version: receipt.version,
        contentHash: plan.sourceHash, registryHash: receipt.registryHash, input, executionProfile: "protected-operation-v1", protectedCompilation: receipt },
      protectedInvocationSecret: ledger.snapshot(), protectedJobSecret: { profile: "protected-operation-job/v1", actorId: s.actor.id, roleId: s.actor.roleId,
        admittedRole: s.actor.role, departmentId: s.actor.departmentId, permissionsHash: hash([...new Set(s.actor.permissions)].sort()), publicationId: String(version.id),
        idempotencyScope: hash(["test-only-report", runId]), requestFingerprint: hash(input), createdAt, state: "QUEUED", admissionSeal: "0".repeat(64) } };
    run.protectedJobSecret!.admissionSeal = protectedAdmissionSeal(s.services, run);
    state.executions[runId] = run; state.timelines[runId] = []; state.executionLogs[runId] = []; state.executionEvents[runId] = [];
    sealProtectedCursor(s.services, state, run, machine);
  });
  const reply = (args: Record<string, unknown>) => {
    const page = mode === "page" ? Number(args.page) : args.cursor === "" ? 1 : 2;
    return { content: [], structuredContent: { startAt: args.startAt, endAt: args.endAt, complete: page === 2, hasMore: page !== 2,
      items: [{ id: `${args.id}-${page}` }], count: 1, snapshot: `private-snapshot-${args.id}`, total: 2,
      ...(mode === "page" ? { page } : { cursor: args.cursor, nextCursor: page === 1 ? "private-cursor-2" : "" }) } };
  };
  s.sdk.callTool.mockImplementation((async (_name: string, args: Record<string, unknown>) => reply(args)) as any);
  return { ...s, runId, tool, reply };
}

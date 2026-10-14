import { afterEach, expect, test, vi } from "vitest";
import { protectedReportFixture as fixture } from "./fixtures/protected-report.js";
import { runProtectedOperation } from "../src/runner/protected-job-worker.js";
import { ProtectedJobCheckpoints } from "../src/runner/protected-job-checkpoints.js";
import { restoreProtectedJob, assertProtectedJobCurrent } from "../src/runner/protected-job-state.js";
import { admitProtectedOperation } from "../src/runner/protected-job-admission.js";
import { Repository } from "../src/repository/store.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { Database, FakeClient } from "./fixtures/fake-firestore.js";
import { performance } from "node:perf_hooks";
import { executeProtectedReport } from "../src/runner/protected-job-report.js";
import * as readBroker from "../src/tools/read-tool-broker.js";
import { fixtureSequence as seq, fixtureAction as action } from "./fixtures/protected-simulation.js";

vi.setConfig({ testTimeout: 20_000 });
const firestore = vi.hoisted(() => ({ db: null as Database | null }));
vi.mock("@google-cloud/firestore", () => ({ Firestore: class { constructor(settings: unknown) { return new FakeClient(firestore.db!, settings); } } }));
const closers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const value of closers.splice(0).reverse()) await value.close(); vi.restoreAllMocks(); });
async function setup(mode: "page" | "cursor" = "cursor", items = ["one"]) { const s = await fixture(mode, items); closers.push(s); return s; }
type Setup = Awaited<ReturnType<typeof setup>>;
const run = (s: Setup) => runProtectedOperation(s.services, s.runId);
async function firstPage(s: Setup) {
  const cp = await selectedReport(s); await cp.executeReportBoundary(); return cp;
}
async function selectedReport(s: Setup) {
  const cp = (await ProtectedJobCheckpoints.claim(s.services, s.runId))!;
  await cp.initialize();
  for (;;) { const point = await cp.next(); if (point?.kind === "action") break; if (!point) throw new Error("Missing report boundary"); await cp.advanceControl(point); }
  return cp;
}

test.each(["preparing-denial", "entered-malformed"])("direct report %s immediately releases claim, fences its controller and preserves honest failed history", async failure => {
  const s = await setup(), cp = await selectedReport(s);
  if (failure === "preparing-denial") vi.spyOn(readBroker, "dispatchReadTool").mockRejectedValue(new Error("Synthetic before-SDK policy denial"));
  else s.sdk.callTool.mockImplementation((async (_name: string, args: Record<string, unknown>) => {
    const output: any = s.reply(args); output.structuredContent.complete = "not-a-boolean"; return output;
  }) as any);
  await expect(cp.executeReportBoundary()).rejects.toThrow();
  const snapshot = await s.repository.snapshot(), execution = snapshot.executions[s.runId]!;
  expect(execution.status).toBe(failure === "preparing-denial" ? "FAILED" : "RECOVERY_REQUIRED");
  expect(execution.protectedJobSecret!.state).toBe(failure === "preparing-denial" ? "FINISHED" : "RECOVERY_REQUIRED");
  expect(execution.protectedJobSecret!.lease).toBeUndefined(); expect(cp.controller.signal.aborted).toBe(true);
  expect(execution.stepOutputs).toEqual({}); expect(execution.reportCoverages).toBeUndefined(); expect(execution.finalOutput).toBeUndefined();
  expect(execution.reportPageSecret!["each/0/report"]!.pages).toHaveLength(0);
  expect(Object.values(execution.protectedInvocationSecret!.intents)[0]!.state).toBe(failure === "preparing-denial" ? "PREPARING" : "UNKNOWN");
  restoreProtectedJob(snapshot, s.services, s.runId);
  await expect(cp.executeReportBoundary()).rejects.toThrow(/fenced/); await expect(cp.executeAction()).rejects.toThrow(/fenced/);
  expect((await run(s)).status).toBe(execution.status); expect(s.sdk.callTool).toHaveBeenCalledTimes(failure === "preparing-denial" ? 0 : 1);
});

test.each(["page", "cursor"] as const)("%s report aggregates exact pages into distinct item answers with public admission closed", async mode => {
  const s = await setup(mode, ["same", "same"]);
  await expect(admitProtectedOperation(s.services, "flow", s.actor, { items: ["same"] }, "report-public-gate-closed-0001")).rejects.toThrow(/drivers/);
  const result = await run(s); expect(result.status, JSON.stringify(result)).toBe("DONE"); expect(result.finalOutput).toEqual([2, 2]);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(4); expect(s.modelFetch).not.toHaveBeenCalled();
  expect(Object.keys(result.stepOutputs as object)).toEqual(["each/0/report", "each/1/report"]);
  const saved = await s.repository.snapshot(); restoreProtectedJob(saved, s.services, s.runId);
  expect(Object.keys(saved.executions[s.runId]!.reportCoverages!)).toEqual(["each/0/report", "each/1/report"]);
  expect(saved.executions[s.runId]).not.toHaveProperty("reportPageSecret");
  expect(JSON.stringify(result)).not.toMatch(/private-snapshot|private-cursor|reportPageSecret|protectedInvocationSecret/);
  expect((await run(s)).status).toBe("DONE"); expect(s.sdk.callTool).toHaveBeenCalledTimes(4);
});

test.each(["page", "cursor"] as const)("%s confirmed page yields and resumes at next ordinal without exposing partial coverage", async mode => {
  const s = await setup(mode), cp = await firstPage(s); await cp.yield();
  const before = await s.repository.snapshot(), execution = before.executions[s.runId]!;
  expect(execution.stepOutputs).toEqual({}); expect(execution.reportCoverages).toBeUndefined();
  expect(execution.reportPageSecret!["each/0/report"]!.pages).toHaveLength(1); restoreProtectedJob(before, s.services, s.runId);
  const result = await run(s); expect(result.status, JSON.stringify(result)).toBe("DONE"); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
  const calls = s.sdk.callTool.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
  expect(calls.map(call => call[1][mode === "page" ? "page" : "cursor"])).toEqual(mode === "page" ? [1, 2] : ["", "private-cursor-2"]);
});

test.each(["window", "missing-page", "snapshot", "total", "count", "schema", "cycle", "max-pages", "transport"])("%s cannot manufacture complete report or advance a sibling", async failure => {
  const s = await setup(failure === "missing-page" ? "page" : "cursor", ["one", "two"]);
  s.sdk.callTool.mockImplementation((async (_name: string, args: Record<string, unknown>) => {
    if (failure === "transport") throw new Error("Synthetic entered report disconnect");
    const output: any = s.reply(args), body = output.structuredContent, second = args.cursor !== "" && args.cursor !== undefined || args.page === 2;
    if (failure === "window") body.startAt = "2026-09-01T00:00:00.000Z";
    if (failure === "missing-page") body.page++;
    if (failure === "snapshot" && second) body.snapshot = "different-snapshot";
    if (failure === "total") body.total = second ? 3 : 2;
    if (failure === "count") body.count = 2;
    if (failure === "schema") body.complete = "true";
    if (failure === "cycle" && second) { body.complete = false; body.hasMore = true; body.nextCursor = "private-cursor-2"; body.total = 3; }
    if (failure === "max-pages") { body.complete = false; body.hasMore = true; body.total = 10; body.nextCursor = `cursor-${s.sdk.callTool.mock.calls.length}`; }
    return output;
  }) as any);
  const result = await run(s); expect(result.status, JSON.stringify(result)).toBe("RECOVERY_REQUIRED"); expect(result.stepOutputs).toEqual({}); expect(result.reportCoverages).toBeUndefined();
  const calls = s.sdk.callTool.mock.calls.length; expect(calls).toBeLessThanOrEqual(3);
  expect((await run(s)).status).toBe("RECOVERY_REQUIRED"); expect(s.sdk.callTool).toHaveBeenCalledTimes(calls);
});

test.each(["requester", "cancel", "capability"])("%s revocation after first page prevents next SDK entry", async change => {
  const s = await setup(), cp = await firstPage(s); await cp.yield();
  await s.repository.mutate(state => {
    if (change === "requester") state.users.requester!.status = "Suspended";
    else if (change === "cancel") state.executions[s.runId]!.readProgress!.cancellation = { requestedAt: new Date().toISOString(), requestedBy: "requester" } as any;
    else { for (const row of Object.values(state.capabilityAdmissions)) if ((row as any).state === "AVAILABLE") { row.state = "DISABLED"; row.version = Number(row.version) + 1; } }
  });
  const result = await run(s); expect(["FAILED", "CANCELLED"]).toContain(result.status); expect(s.sdk.callTool).toHaveBeenCalledTimes(1); expect(result.stepOutputs).toEqual({});
});

test.each([
  { stage: "page", phase: "before", expected: "RECOVERY_REQUIRED", calls: 1 },
  { stage: "page", phase: "after", expected: "DONE", calls: 2 },
  { stage: "coverage", phase: "before", expected: "RECOVERY_REQUIRED", calls: 2 },
  { stage: "coverage", phase: "after", expected: "DONE", calls: 2 },
] as const)("$stage result $phase-COMMIT loss fences authority; authoritative recovery gives $expected without page replay", async scenario => {
  // Actual encrypted adapter over a fake transaction SDK. This is explicitly
  // separate from an actual-emulator or killed-process restart campaign.
  const db = firestore.db = new Database(), wallAt = Date.now(), monotonicAt = performance.now();
  const storage = await FirestoreRecordPersistence.open("x".repeat(32), { projectId: "demo-protected-report", databaseId: "(default)", workspaceId: "report_fault_fixture" },
    { clock: { sample: () => { const monotonic = performance.now(); return { wall: Math.floor(wallAt + monotonic - monotonicAt), monotonic }; } } });
  closers.push(storage); const repository = await Repository.open(storage), s = await fixture("cursor", ["one"], repository); closers.push(s);
  const save = storage.saveExecutionCheckpoint.bind(storage); let injected = false;
  vi.spyOn(storage, "saveExecutionCheckpoint").mockImplementation(async checkpoint => {
    const execution = checkpoint.execution;
    if (!injected && (scenario.stage === "page" ? execution?.reportPageSecret?.["each/0/report"]?.pages.length === 1 : !!execution?.reportCoverages?.["each/0/report"])) {
      injected = true; db.fault = scenario.phase === "before" ? "before-commit" : "after-commit";
    }
    await save(checkpoint);
  });
  await expect(run(s)).rejects.toThrow(/unavailable|fenced/); expect(injected).toBe(true);
  expect(() => repository.assertAuthority()).toThrow(); await expect(run(s)).rejects.toThrow();
  await repository.recoverPersistenceState(); const confirmed = await repository.snapshot(), execution = confirmed.executions[s.runId]!;
  restoreProtectedJob(confirmed, s.services, s.runId);
  if (scenario.stage === "page") expect(execution.reportPageSecret!["each/0/report"]!.pages).toHaveLength(scenario.phase === "after" ? 1 : 0);
  if (scenario.stage === "coverage") expect(Boolean(execution.reportCoverages?.["each/0/report"])).toBe(scenario.phase === "after");
  vi.spyOn(Date, "now").mockReturnValue(Math.max(Date.now(), execution.protectedJobSecret!.lease!.expiresAt + 1));
  const result = await run(s); expect(result.status, JSON.stringify(result)).toBe(scenario.expected); expect(s.sdk.callTool).toHaveBeenCalledTimes(scenario.calls);
  expect((await run(s)).status).toBe(scenario.expected); expect(s.sdk.callTool).toHaveBeenCalledTimes(scenario.calls);
  if (scenario.expected === "DONE") expect(result.finalOutput).toEqual([2]); else { expect(result.stepOutputs).toEqual({}); expect(result.reportCoverages).toBeUndefined(); }
});

test("sealed accumulator rejects cross-item or changed next-cursor bytes before dispatch", async () => {
  const s = await setup(), cp = await firstPage(s); await cp.yield();
  const snapshot = await s.repository.snapshot(); const execution = snapshot.executions[s.runId]!;
  (execution.reportPageSecret!["each/0/report"] as any).nextCursor = "forged-cursor";
  expect(() => restoreProtectedJob(snapshot, s.services, s.runId)).toThrow(); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
});

test("injected valid-looking page callback cannot mint owned report completion", async () => {
  const s = await setup(), cp = (await ProtectedJobCheckpoints.claim(s.services, s.runId))!; await cp.initialize();
  try {
    for (;;) { const point = (await cp.next())!; if (point.kind === "action") break; await cp.advanceControl(point); }
    const execution = (await s.repository.snapshot()).executions[s.runId]!, lease = execution.protectedJobSecret!.lease!;
    const owner = { leaseId: lease.id, workerId: lease.workerId, epoch: execution.readProgress!.epoch };
    await expect(executeProtectedReport(s.services, s.runId, { checkpoints: cp, owner, oneBoundary: true, guard: () => cp.assertDispatch(),
      current: state => assertProtectedJobCurrent(state, s.services, s.runId, owner), dispatch: async call => s.reply(call.args),
      advance: () => { throw new Error("Forged result must not advance"); } })).rejects.toThrow(/genuine exact broker/);
    expect(s.sdk.callTool).not.toHaveBeenCalled(); expect((await s.repository.snapshot()).executions[s.runId]!.stepOutputs).toEqual({});
    await cp.stop();
  } finally { cp.close(); }
});

test("clone of genuine SDK page cannot substitute for its one-use broker receipt", async () => {
  const s = await setup(), dispatch = readBroker.dispatchReadTool;
  vi.spyOn(readBroker, "dispatchReadTool").mockImplementation(async (...args) => structuredClone(await dispatch(...args)));
  const result = await run(s); expect(result.status).toBe("RECOVERY_REQUIRED"); expect(result.stepOutputs).toEqual({});
  expect(s.sdk.callTool).toHaveBeenCalledTimes(1); expect((await run(s)).status).toBe("RECOVERY_REQUIRED"); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
});

test.each(["reuse", "actor", "run", "workflow", "admission", "args", "controller"])("broker success receipt rejects %s substitution and cannot advance report", async damage => {
  const s = await setup(), dispatch = readBroker.dispatchReadTool;
  vi.spyOn(readBroker, "dispatchReadTool").mockImplementation(async (services, actorId, name, args, context) => {
    const result = await dispatch(services, actorId, name, args, context), cp = context!.protectedInvocation!.checkpoints;
    const binding = { actorId, executionId: context!.executionId!, workflowId: context!.workflowId!, admissionPin: context!.plan!.admissionPin! };
    if (damage === "actor") binding.actorId = "different-actor";
    if (damage === "run") binding.executionId = "different-run";
    if (damage === "workflow") binding.workflowId = "different-workflow";
    if (damage === "admission") binding.admissionPin = { ...binding.admissionPin, admissionVersion: binding.admissionPin.admissionVersion + 1 };
    const proof = readBroker.consumeAcknowledgedProtectedReadResult(result, damage === "controller" ? {} as any : cp,
      s.tool.tool_id, context!.plan!.contractHash!, damage === "args" ? { ...args, cursor: "different" } : args, binding);
    if (damage === "reuse") {
      expect(proof).toEqual(result);
      expect(readBroker.consumeAcknowledgedProtectedReadResult(result, cp, s.tool.tool_id, context!.plan!.contractHash!, args, binding)).toBeUndefined();
    } else expect(proof).toBeUndefined();
    return result;
  });
  const result = await run(s); expect(result.status).toBe("RECOVERY_REQUIRED"); expect(result.stepOutputs).toEqual({}); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
});

test("unselected report branch creates no pages or false coverage", async () => {
  const s = await fixture("cursor", ["one"], undefined, source => {
    source.metadata.controlFlow.root.nodes[0].body = seq({ kind: "if", id: "gate", predicate: { kind: "literal", value: false }, then: seq(action("report")), else: seq() });
    source.metadata.controlFlow.root.nodes[0].collect.value = { kind: "literal", value: 0 };
  }); closers.push(s);
  const result = await run(s); expect(result.status).toBe("DONE"); expect(result.finalOutput).toEqual([0]); expect(s.sdk.callTool).not.toHaveBeenCalled(); expect(result.reportCoverages).toBeUndefined();
});

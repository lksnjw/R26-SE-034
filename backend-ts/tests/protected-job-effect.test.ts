import { afterEach, expect, test, vi } from "vitest";
import { protectedEffectFixture as fixture } from "./fixtures/protected-effect.js";
import { runProtectedOperation } from "../src/runner/protected-job-worker.js";
import { ProtectedJobCheckpoints } from "../src/runner/protected-job-checkpoints.js";
import { restoreProtectedJob } from "../src/runner/protected-job-state.js";
import { admitProtectedOperation } from "../src/runner/protected-job-admission.js";
import { performance } from "node:perf_hooks";
import { Repository } from "../src/repository/store.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { Database, FakeClient } from "./fixtures/fake-firestore.js";
import { fixtureSequence as seq, fixtureAction as action, fixtureRef as ref } from "./fixtures/protected-simulation.js";

vi.setConfig({ testTimeout: 15_000 });
const firestore = vi.hoisted(() => ({ db: null as Database | null }));
vi.mock("@google-cloud/firestore", () => ({ Firestore: class {
  constructor(settings: unknown) { return new FakeClient(firestore.db!, settings); }
} }));
const closers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const item of closers.splice(0).reverse()) await item.close(); vi.restoreAllMocks(); vi.useRealTimers(); });
async function setup(configure?: (source: any) => void, items?: string[], repository?: Repository) {
  const s = await fixture(configure, repository); closers.push(s); await s.seed(items); return s;
}
type Setup = Awaited<ReturnType<typeof setup>>;
const run = (s: Setup) => runProtectedOperation(s.services, s.runId);
async function approved(s: Setup) {
  expect((await run(s)).status).toBe("AWAITING_APPROVAL");
  const before = await s.active();
  const response = await s.decide(); expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toMatchObject({ state: "APPROVED", resumeQueued: false });
  expect(s.sdk.callTool).not.toHaveBeenCalled();
  return before;
}

test("private owned effect first waits without SDK entry; normal whole-effect admission remains closed", async () => {
  const s = await setup();
  await expect(admitProtectedOperation(s.services, "flow", s.actor, { items: ["one"] }, "normal-effect-still-denied-0001")).rejects.toThrow(/drivers/);
  const result = await run(s), state = await s.repository.snapshot(), row = await s.active();
  expect(result.status).toBe("AWAITING_APPROVAL"); expect(result.stepOutputs).toEqual({});
  expect(row).toMatchObject({ state: "PENDING", arguments: { id: "one" }, binding: { invocationId: "each/0/send", iterations: [{ loopId: "each", index: 0 }] } });
  expect(state.executions[s.runId]!.protectedJobSecret).not.toHaveProperty("lease");
  expect(s.sdk.callTool).not.toHaveBeenCalled(); expect(s.modelFetch).not.toHaveBeenCalled();
});

test("fresh approved claim preserves original intent, deadline and exact item; sibling needs its own decision", async () => {
  const s = await setup(undefined, ["same", "same"]), original = await approved(s);
  const first = await run(s), state = await s.repository.snapshot();
  expect(first.status).toBe("AWAITING_APPROVAL"); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
  const entered = s.sdk.callTool.mock.calls[0] as unknown as unknown[];
  expect(entered).toEqual(["hr.notify.rev_MS4wLjA", { id: "same", role: "admin" }, { "toolplane.resourceDigest": "b".repeat(64) }]);
  expect(first.stepOutputs).toHaveProperty("each/0/send.structuredContent.accepted", true);
  const consumed = state.executions[s.runId]!.protectedApprovalSecret!.records[original.id]!;
  expect(consumed).toMatchObject({ state: "CONSUMED", requestedAt: original.requestedAt, expiresAt: original.expiresAt, reviewHash: original.reviewHash,
    binding: { intentId: original.binding.intentId, intentKey: original.binding.intentKey } });
  expect(consumed.consumption!.epoch).toBeGreaterThan(original.binding.requestEpoch);
  expect(state.executions[s.runId]!.protectedInvocationSecret!.intents[original.binding.intentKey]).toMatchObject({ state: "ACKNOWLEDGED", id: original.binding.intentId });
  const next = await s.active(); expect(next.id).not.toBe(original.id); expect(next.binding.invocationId).toBe("each/1/send"); expect(next.state).toBe("PENDING");
  expect((await run(s)).status).toBe("AWAITING_APPROVAL"); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
  expect((await s.decide()).statusCode).toBe(200);
  const result = await run(s); expect(result.status, JSON.stringify(result)).toBe("DONE"); expect(result.finalOutput).toEqual([true, true]);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(2); expect(Object.keys(result.stepOutputs as object)).toEqual(["each/0/send", "each/1/send"]);
  expect((await run(s)).status).toBe("DONE"); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
  const final = (await s.repository.snapshot()).executions[s.runId]!;
  expect(final).not.toHaveProperty("operationSecret"); expect(final).not.toHaveProperty("runtimeApprovalSecret"); expect(final.readProgress!.attempts).toEqual({});
  expect(JSON.stringify(result)).not.toMatch(/protectedInvocationSecret|protectedApprovalSecret|protectedJobSecret|admissionSeal|sdkReceipt|private-synthetic-token/);
  restoreProtectedJob(await s.repository.snapshot(), s.services, s.runId);
});

test("self decision cannot authorize effect; independent rejection closes without any SDK call", async () => {
  const s = await setup(); expect((await run(s)).status).toBe("AWAITING_APPROVAL");
  expect((await s.decide("approve", "requester")).statusCode).not.toBe(200);
  expect((await s.decide("reject")).statusCode).toBe(200);
  expect((await run(s)).status).toBe("FAILED"); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test.each(["requester", "reviewer", "policy", "publication", "source", "role-map", "session"])("%s changed before fresh claim cannot authorize SDK entry", async change => {
  const s = await setup(); await approved(s);
  if (change === "role-map") s.config.erpbridgeRoleMap = { "Platform Admin": "other" };
  else if (change === "session") await s.session.close();
  else await s.repository.mutate(state => {
    if (change === "requester") state.users.requester!.status = "Suspended";
    if (change === "reviewer") state.users.reviewer!.status = "Suspended";
    if (change === "policy") (state.settings.rbac as any).runtimeApprovalPolicy.ttlSeconds++;
    if (change === "publication") state.workflows.flow!.publishedVersion++;
    if (change === "source") state.workflows.flow!.yaml += "\n# changed authored publication\n";
  });
  const result = await run(s); expect(["FAILED", "BLOCKED", "CANCELLED"]).toContain(result.status); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("original deadline expiry cannot renew the approval or transfer it into an SDK call", async () => {
  const s = await setup(), row = await approved(s);
  const realNow = Date.now(); vi.spyOn(Date, "now").mockReturnValue(Math.max(realNow, Date.parse(row.expiresAt) + 1));
  const result = await run(s); expect(result.status).toBe("FAILED"); expect(s.sdk.callTool).not.toHaveBeenCalled();
  const record = (await s.repository.snapshot()).executions[s.runId]!.protectedApprovalSecret!.records[row.id]!;
  expect(record).toMatchObject({ state: "EXPIRED", requestedAt: row.requestedAt, expiresAt: row.expiresAt });
});

test("approved cancellation closes private evidence and prevents resume", async () => {
  const s = await setup(), row = await approved(s); const response = await s.as("requester", "POST", "/cancel");
  expect(response.statusCode, response.body).toBe(200); expect((await run(s)).status).toBe("CANCELLED"); expect(s.sdk.callTool).not.toHaveBeenCalled();
  expect((await s.repository.snapshot()).executions[s.runId]!.protectedApprovalSecret!.records[row.id]).toMatchObject({ state: "CLOSED", closure: { reason: "PROTECTED_APPROVAL_CANCELLED" } });
});

test.each(["timeout", "isError", "malformed", "confirmation", "oversize"])("%s after SDK entry is uncertain, never advances sibling or repeats the call", async failure => {
  const s = await setup(), row = await approved(s);
  s.sdk.callTool.mockImplementation((async () => {
    if (failure === "timeout") throw new Error("Synthetic transport lost after entry");
    if (failure === "isError") return { content: [], isError: true, _meta: { "com.erpbridge/error": { type: "not_found", retryable: false } } };
    if (failure === "malformed") return { content: [], structuredContent: { accepted: "true" } };
    if (failure === "confirmation") return { content: [], structuredContent: { accepted: false } };
    return { content: [{ type: "text", text: "x".repeat(1_100_000) }], structuredContent: { accepted: true } };
  }) as any);
  const result = await run(s); expect(result.status).toBe("RECOVERY_REQUIRED"); expect(result.stepOutputs).toEqual({}); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
  const state = await s.repository.snapshot(); expect(state.executions[s.runId]!.protectedApprovalSecret!.records[row.id]!.state).toBe("CONSUMED");
  expect(state.executions[s.runId]!.protectedInvocationSecret!.intents[row.binding.intentKey]!.state).toBe("UNKNOWN");
  expect((await run(s)).status).toBe("RECOVERY_REQUIRED"); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
  expect((await s.as("requester", "POST", "/retry")).statusCode).toBe(409);
});

test("reviewer revoked while SDK awaits leaves uncertainty even if valid-looking acceptance arrives", async () => {
  const s = await setup(); await approved(s);
  s.sdk.callTool.mockImplementation((async () => { await s.repository.mutate(state => { state.users.reviewer!.status = "Suspended"; });
    return { content: [], structuredContent: { accepted: true } }; }) as any);
  const result = await run(s); expect(result.status).toBe("RECOVERY_REQUIRED"); expect(result.stepOutputs).toEqual({}); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
});

test.each([
  { stage: "consumption", phase: "before", committedIntent: "PREPARING", resumedStatus: "DONE", calls: 1 },
  { stage: "consumption", phase: "after", committedIntent: "DISPATCH_INTENT", resumedStatus: "RECOVERY_REQUIRED", calls: 0 },
  { stage: "completion", phase: "before", committedIntent: "DISPATCH_INTENT", resumedStatus: "RECOVERY_REQUIRED", calls: 1 },
  { stage: "completion", phase: "after", committedIntent: "ACKNOWLEDGED", resumedStatus: "DONE", calls: 1 },
] as const)("$stage save $phase commit fences until authoritative reload, then yields $resumedStatus", async scenario => {
  // Genuine encrypted/scoped application adapter with synthetic Firestore
  // transactions. Neither this fake SDK nor injected ERP I/O is live evidence.
  const db = firestore.db = new Database(), wallAt = Date.now(), monotonicAt = performance.now();
  const storage = await FirestoreRecordPersistence.open("x".repeat(32), {
    projectId: "demo-protected-effect", databaseId: "(default)", workspaceId: "effect_acknowledgement_fixture",
  }, { clock: { sample: () => { const monotonic = performance.now(); return { wall: Math.floor(wallAt + monotonic - monotonicAt), monotonic }; } } });
  closers.push(storage);
  const repository = await Repository.open(storage);
  const s = await setup(undefined, ["one"], repository), original = await approved(s);
  let failures = 0, cached = (await repository.snapshot()).executions[s.runId]!;
  const unsubscribe = repository.observeCommits({ committed: state => { cached = structuredClone(state.executions[s.runId]!); }, unavailable: () => {} });
  closers.push({ close: async () => unsubscribe() });
  const save = storage.saveExecutionCheckpoint.bind(storage);
  vi.spyOn(storage, "saveExecutionCheckpoint").mockImplementation(async checkpoint => {
    const records = Object.values(checkpoint.execution?.protectedApprovalSecret?.records ?? {});
    if (!failures && records.some(row => row.state === "CONSUMED" && (scenario.stage === "completion" ? !!row.sdkReceipt : !row.sdkReceipt))) {
      failures++; db.fault = scenario.phase === "before" ? "before-commit" : "after-commit";
    }
    await save(checkpoint);
  });
  await expect(run(s)).rejects.toThrow(/unavailable|fenced/);
  expect(failures).toBe(1);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(scenario.stage === "completion" ? 1 : 0);
  expect(cached.status).toBe("RUNNING"); expect(cached.stepOutputs).toEqual({});
  expect(cached.protectedApprovalSecret!.records[original.id]).not.toHaveProperty("sdkReceipt");
  await expect(run(s)).rejects.toThrow(/unavailable|fenced/);
  await expect(repository.snapshot()).rejects.toThrow(/unavailable|fenced/);
  await expect(repository.readAuthoritative(() => undefined)).rejects.toThrow(/unavailable/);
  await repository.recoverPersistenceState();
  const confirmed = (await repository.snapshot()).executions[s.runId]!;
  expect(confirmed.protectedInvocationSecret!.intents[original.binding.intentKey]!.state).toBe(scenario.committedIntent);
  expect(confirmed.protectedApprovalSecret!.records[original.id]).toMatchObject({ requestedAt: original.requestedAt,
    expiresAt: original.expiresAt, reviewHash: original.reviewHash });
  if (scenario.stage === "completion" && scenario.phase === "after") {
    expect(confirmed.stepOutputs).toHaveProperty("each/0/send.structuredContent.accepted", true);
    expect(confirmed.protectedApprovalSecret!.records[original.id]!.sdkReceipt).toMatchObject({ meaning: "operation-accepted" });
  } else expect(confirmed.stepOutputs).toEqual({});
  const realNow = Date.now();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Math.max(realNow, confirmed.protectedJobSecret!.lease!.expiresAt + 1));
  const result = await run(s); expect(result.status, JSON.stringify(result)).toBe(scenario.resumedStatus);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(scenario.calls);
  expect((await run(s)).status).toBe(scenario.resumedStatus); expect(s.sdk.callTool).toHaveBeenCalledTimes(scenario.calls);
  if (scenario.resumedStatus === "DONE") expect(result.finalOutput).toEqual([true]);
  else expect(result.stepOutputs).toEqual({});
  expect(s.modelFetch).not.toHaveBeenCalled();
});

test("two concurrent claimants cannot duplicate one approved invocation", async () => {
  const s = await setup(undefined, ["one"]); await approved(s);
  const results = await Promise.allSettled([ProtectedJobCheckpoints.claim(s.services, s.runId), ProtectedJobCheckpoints.claim(s.services, s.runId)]);
  const winners = results.filter((value): value is PromiseFulfilledResult<ProtectedJobCheckpoints | undefined> => value.status === "fulfilled" && !!value.value);
  expect(winners).toHaveLength(1); expect(results.filter(value => value.status === "rejected")).toHaveLength(1);
  const cp = winners[0]!.value!;
  try { await cp.initialize(); for (;;) { const point = await cp.next(); if (!point) break; if (point.kind === "action") await cp.executeAction(); else await cp.advanceControl(point); } }
  finally { cp.close(); }
  expect((await run(s)).status).toBe("DONE"); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
});

test("nested item tuples isolate identical arguments and preserve qualified answers", async () => {
  const s = await setup(source => {
    const outer = source.metadata.controlFlow.root.nodes[0]; source.steps[0].parameters.id = "{{inner.item}}";
    outer.body = seq({ kind: "foreach", id: "inner", maxItems: 2,
      items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "array", items: [{ kind: "literal", value: "same" }] } },
      body: seq(action("send")), collect: { schema: { type: "boolean" }, value: ref("send", "structuredContent", "accepted") } });
    outer.collect = { schema: { type: "array", items: { type: "boolean" } }, value: ref("inner", "value") };
    source.metadata.controlFlow.root.nodes[1].output.schema = { type: "array", items: { type: "array", items: { type: "boolean" } } };
  }, ["outer-one", "outer-two"]);
  await approved(s); const first = await run(s); expect(first.status).toBe("AWAITING_APPROVAL");
  const row = await s.active(); expect(row.binding.invocationId).toBe("each/1/inner/0/send");
  expect(row.binding.iterations).toEqual([{ loopId: "each", index: 1 }, { loopId: "inner", index: 0 }]);
  expect((await s.decide()).statusCode).toBe(200); const result = await run(s);
  expect(result.status, JSON.stringify(result)).toBe("DONE"); expect(result.finalOutput).toEqual([[true], [true]]);
  expect(Object.keys(result.stepOutputs as object)).toEqual(["each/0/inner/0/send", "each/1/inner/0/send"]); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

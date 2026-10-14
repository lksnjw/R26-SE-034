import { expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { Repository, type RepositoryState, type PersistenceBackend, type Execution } from "../src/repository/store.js";
import { toolSchema } from "../src/registry/schemas.js";
import { compileReadWorkflow, readCompilationReceipt } from "../src/workflows/compiled-read.js";
import { newReadProgress, reconcileInterruptedExecutions } from "../src/runner/read-checkpoints.js";
import { ReadIterationCheckpoints, newReadIterationLedger, type IterationBoundary } from "../src/runner/read-iteration-checkpoints.js";
import * as interpreter from "../src/workflows/read-interpreter.js";
import { ReadMachine } from "../src/workflows/read-machine.js";

const role = "Platform Admin", key = "server-held-iteration-fixture-key-32-bytes";
const tool = toolSchema.parse({ tool_id: "READ", name: "read", mcp_tool_name: "read", is_read_only: true, allowed_roles: [role], input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } });
const seq = (...nodes: any[]) => ({ kind: "sequence", nodes }), action = (nodeId: string) => ({ kind: "action", nodeId });
const ref = (nodeId: string, path: string[]) => ({ kind: "ref", source: "nodeOutput", nodeId, path });
const array = { type: "array", items: { type: "string" } };
const output = (id: string) => ({ content: [], structuredContent: { id } });
function source(): any { return { name: "Collection", description: "Read bounded invoices", trigger: { type: "manual" }, steps: [{ id: "read", action: "read", parameters: { id: "{{each.item}}" } }], metadata: { controlFlow: { schemaVersion: "read-control-flow/v3", root: seq({ kind: "foreach", id: "each", items: { schema: array, value: { kind: "ref", source: "workflowInput", path: ["rows"] } }, maxItems: 3, body: seq(action("read")), collect: { schema: { type: "string" }, value: ref("read", ["structuredContent", "id"]) } }, { kind: "return", id: "answer", output: { schema: array, value: ref("each", ["value"]) } }) } } }; }
class Persistence implements PersistenceBackend {
  payload: Uint8Array | null = null; fail = false; committedLoss = false;
  async load() { return this.payload; }
  async save(value: Uint8Array) { if (this.fail) { this.fail = false; if (this.committedLoss) this.payload = Buffer.from(value); throw new Error("Lost storage acknowledgement"); } this.payload = Buffer.from(value); }
  async probe() {} async close() {}
}
async function setup(src = source(), input: Record<string, unknown> = { rows: ["a", "b"], private_token: "never-persist-this-input-secret" }, persistence: PersistenceBackend | null = null, executionId = "run") {
  const repository = await Repository.open(persistence), yaml = stringify(src), plan = compileReadWorkflow(yaml, [tool], role), now = new Date().toISOString();
  const item: Execution = { id: executionId, workflowId: "flow", workflowName: "Collection", status: "RUNNING", startedAt: now, completedAt: null, durationMs: 0, costUsd: 0, tokens: { input: 0, output: 0, total: 0 }, startedBy: { id: "actor", name: "Actor" }, workflowSnapshot: { version: 1, contentHash: plan.sourceHash, registryHash: "registry", yaml, input: {}, executionProfile: "collection-read-v1", compilation: readCompilationReceipt(plan, "registry", "PUBLICATION", "fixture-legacy") }, readProgress: newReadProgress(repository), iterationProgress: newReadIterationLedger(executionId, plan, input, role, key) };
  await repository.mutate(state => {
    state.users.actor = { id: "actor", name: "Actor", email: "actor@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "A", departmentId: null, lastLoginAt: null, createdAt: now };
    state.workflows.flow = { id: "flow", name: "Collection", owner: { id: "actor", name: "Actor" }, assignedUserIds: ["actor"], archived: false } as any;
    state.executions[executionId] = item;
  });
  const worker = (repo = repository, privateData = input, epoch = 1, bindingKey = key) => new ReadIterationCheckpoints(repo, executionId, epoch, yaml, plan, privateData, [tool], bindingKey);
  return { repository, yaml, plan, input, worker, get: async () => (await repository.snapshot()).executions[executionId]! };
}
async function perform(worker: ReadIterationCheckpoints, answer = "answer"): Promise<IterationBoundary> {
  const point = await worker.advance(); expect(point?.kind).toBe("action");
  await worker.dispatchIntent(point!.visit, role); await worker.completed(point!.visit, output(answer)); return point!;
}
async function drain(worker: ReadIterationCheckpoints) {
  const points: IterationBoundary[] = [];
  for (let count = 0; count < 1000; count++) {
    const point = await worker.advance(); if (!point) return points; points.push(point);
    if (point.kind === "action" && point.valid) { await worker.dispatchIntent(point.visit, role); await worker.completed(point.visit, output(String(point.arguments!.id).toUpperCase())); }
    if (!point.valid) return points;
  }
  throw new Error("Fixture traversal failed to terminate");
}

test("durable item attempts, collection values and final return never overwrite answers or expose private inputs in journal", async () => {
  const persist = new Persistence(), s = await setup(source(), { rows: ["a", "b"], private_token: "never-persist-this-input-secret" }, persist);
  const points = await drain(s.worker()); expect(points.filter(point => point.kind === "action").map(point => [point.visit.invocationId, point.arguments])).toEqual([["each/0/read", { id: "a" }], ["each/1/read", { id: "b" }]]);
  const done = await s.worker().finish(); expect(done).toMatchObject({ status: "DONE", finalOutput: ["A", "B"], stepOutputs: { "each/0/read": output("A"), "each/1/read": output("B") }, valueOutputs: { each: { value: ["A", "B"] }, "each/0/each": { value: "A" }, "each/1/each": { value: "B" } } });
  expect(Object.keys(done.readProgress!.attempts)).toEqual(["each/0/read", "each/1/read"]);
  const stored = JSON.stringify(await s.repository.snapshot()); expect(stored).not.toContain("never-persist-this-input-secret"); expect(stored).not.toContain(key); expect(stored).not.toContain('"arguments"');
  const reloaded = await Repository.open(persist); expect((await reloaded.snapshot()).executions.run).toEqual(done);
  const events = (await reloaded.snapshot()).executionEvents.run!; expect(events.map(value => value.sequence)).toEqual(events.map((_value, index) => index + 1));
});

test("empty collections record an explicit empty array and declaration-only skips without action dispatch intent", async () => {
  const s = await setup(source(), { rows: [] }); const points = await drain(s.worker()); expect(points.map(point => point.kind)).toEqual(["collection", "skip", "collection", "return"]);
  const done = await s.worker().finish(); expect(done.status).toBe("DONE"); expect(done.finalOutput).toEqual([]); expect(done.stepOutputs).toBeUndefined(); expect(done.readProgress!.attempts.read!.status).toBe("SKIPPED"); expect(done.readProgress!.attempts.read!.dispatchIntentAt).toBeUndefined();
});

test("nested collections retain complete invocation paths and separate aggregate values", async () => {
  const src = source(), outer = src.metadata.controlFlow.root.nodes[0];
  outer.items.schema = { type: "array", items: array }; outer.body = seq({ kind: "foreach", id: "inner", items: { schema: array, value: ref("each", ["item"]) }, maxItems: 3, body: seq(action("read")), collect: outer.collect }); outer.collect = { schema: array, value: ref("inner", ["value"]) }; src.steps[0].parameters.id = "{{inner.item}}"; src.metadata.controlFlow.root.nodes[1].output.schema = { type: "array", items: array };
  const s = await setup(src, { rows: [["a", "b"], ["c"]] }); const points = await drain(s.worker()); expect(points.filter(point => point.kind === "action").map(point => point.visit.invocationId)).toEqual(["each/0/inner/0/read", "each/0/inner/1/read", "each/1/inner/0/read"]);
  expect((await s.worker().finish()).finalOutput).toEqual([["A", "B"], ["C"]]);
});

test("per-item boolean decisions and typed branch merges have distinct receipts for the same node", async () => {
  const src = source(), loop = src.metadata.controlFlow.root.nodes[0]; loop.items.schema = { type: "array", items: { type: "object", properties: { id: { type: "string" }, enabled: { type: "boolean" } }, required: ["id", "enabled"], additionalProperties: false } };
  loop.body = seq({ kind: "if", id: "gate", predicate: ref("each", ["item", "enabled"]), then: seq(action("read")), else: seq(), merge: { schema: { type: "string" }, then: ref("read", ["structuredContent", "id"]), else: ref("each", ["item", "id"]) } }); loop.collect.value = ref("gate", ["value"]); src.steps[0].parameters.id = "{{each.item.id}}";
  const s = await setup(src, { rows: [{ id: "a", enabled: true }, { id: "b", enabled: false }] }); await drain(s.worker()); const done = await s.worker().finish();
  expect(done.finalOutput).toEqual(["A", "b"]); expect(done.iterationProgress!.receipts["condition:each/0/gate"]!.selected).toBe("then"); expect(done.iterationProgress!.receipts["merge:each/0/gate"]!.status).toBe("DONE"); expect(done.iterationProgress!.receipts["condition:each/1/gate"]!.selected).toBe("else"); expect(done.stepOutputs?.["each/1/read"]).toBeUndefined();
});

test.each([null, "not-a-list", ["a", "b", "c", "d"]])("invalid collection %j saves a failed boundary and cannot claim completion", async rows => {
  const s = await setup(source(), { rows }); const point = await s.worker().advance(); expect(point).toMatchObject({ kind: "collection", valid: false }); await expect(s.worker().finish()).rejects.toThrow(); expect((await s.worker().finish(true)).status).toBe("FAILED"); expect((await s.get()).readProgress!.attempts).toEqual({});
});
test("missing collection data is not silently treated as an empty list", async () => {
  const s = await setup(source(), {}); expect(await s.worker().advance()).toMatchObject({ kind: "collection", valid: false }); expect((await s.worker().finish(true)).valueOutputs).toBeUndefined();
});

test("dispatch and completion require the exact pending item and cannot replay an existing attempt", async () => {
  const s = await setup(), w = s.worker(); await w.advance(); const point = await w.advance();
  await expect(w.advance()).rejects.toThrow(); await expect(w.completed(point!.visit, output("unconfirmed"))).rejects.toThrow();
  await expect(w.dispatchIntent({ invocationId: "each/1/read", iterations: [{ loopId: "each", index: 1 }] }, role)).rejects.toThrow();
  await w.dispatchIntent(point!.visit, role); await expect(w.dispatchIntent(point!.visit, role)).rejects.toThrow(); await w.completed(point!.visit, output("A")); await expect(w.completed(point!.visit, output("replayed"))).rejects.toThrow();
  expect((await s.get()).stepOutputs).toEqual({ "each/0/read": output("A") });
});

test.each(["count", "index", "decision", "output", "timeline", "timeline-identity", "extra", "extra-attempt", "attempt-index", "extra-output", "missing-value", "final", "input", "key", "source", "epoch", "profile"])("forged or changed %s cannot authorize the next boundary", async damage => {
  const s = await setup(), w = s.worker(); await w.advance(); await perform(w, "A"); await w.advance();
  if (!["input", "key", "source", "epoch"].includes(damage)) await s.repository.mutate(state => {
    const item = state.executions.run!, ledger = item.iterationProgress!;
    if (damage === "count") ledger.receipts["collection:each"]!.count = 3;
    if (damage === "index") ledger.receipts["action:each/0/read"]!.iterations = [{ loopId: "each", index: 1 }];
    if (damage === "decision") ledger.receipts["collection-item:each/0/each"]!.status = "FAILED";
    if (damage === "output") item.stepOutputs!["each/0/read"] = output("forged");
    if (damage === "timeline") state.timelines.run = [];
    if (damage === "timeline-identity") state.timelines.run!.find(value => value.invocationId === "each/0/read")!.nodeId = "different";
    if (damage === "extra") ledger.receipts["action:each/1/read"] = { ...ledger.receipts["action:each/0/read"]!, invocationId: "each/1/read" };
    if (damage === "extra-output") item.stepOutputs!.extra = output("unrecorded");
    if (damage === "extra-attempt") item.readProgress!.attempts.extra = { ...item.readProgress!.attempts["each/0/read"]!, nodeId: "extra" };
    if (damage === "attempt-index") item.readProgress!.attempts["each/0/read"]!.stepIndex = 10;
    if (damage === "missing-value") delete item.valueOutputs!["each/0/each"];
    if (damage === "final") item.finalOutput = "unconfirmed final";
    if (damage === "profile") item.workflowSnapshot!.executionProfile = "structured-read-v1";
  });
  const changed = damage === "input" ? s.worker(s.repository, { rows: ["different"] }) : damage === "key" ? s.worker(s.repository, s.input, 1, "other-server-binding-key-of-32-bytes") : damage === "epoch" ? s.worker(s.repository, s.input, 2) : damage === "source" ? new ReadIterationCheckpoints(s.repository, "run", 1, s.yaml.replace("Read bounded invoices", "Changed description"), s.plan, s.input, [tool], key) : w;
  await expect(changed.advance()).rejects.toThrow(); expect((await s.get()).status).toBe("RUNNING");
});

test("a receipt copied from another execution is not valid evidence even with the same plan and items", async () => {
  const s = await setup(), other = await setup(source(), s.input, null, "other-run"); await s.worker().advance(); await other.worker().advance();
  const receipts = (await other.get()).iterationProgress!.receipts;
  await s.repository.mutate(state => { state.executions.run!.iterationProgress!.receipts = receipts; });
  await expect(s.worker().advance()).rejects.toThrow();
});

test.each(["cancel", "disabled", "role", "permissions", "archived"])("changed %s stops before another invocation without erasing saved answers", async change => {
  const s = await setup(), w = s.worker(); await w.advance(); await perform(w, "A"); await w.advance();
  await s.repository.mutate(state => { if (change === "cancel") state.executions.run!.readProgress!.cancellation = { requestedAt: new Date().toISOString(), requestedBy: { id: "actor", name: "Actor" } }; if (change === "disabled") state.users.actor!.status = "Inactive"; if (change === "role") state.users.actor!.roleId = "role_client"; if (change === "permissions") state.roles.role_admin!.permissions = []; if (change === "archived") state.workflows.flow!.archived = true; });
  await expect(w.advance()).rejects.toThrow(); expect((await s.get()).stepOutputs).toEqual({ "each/0/read": output("A") });
});

test("an in-flight answer is saved after cancellation but no dependent item starts", async () => {
  const s = await setup(), w = s.worker(); await w.advance(); const point = await w.advance(); await w.dispatchIntent(point!.visit, role);
  await s.repository.mutate(state => { state.executions.run!.readProgress!.cancellation = { requestedAt: new Date().toISOString(), requestedBy: { id: "actor", name: "Actor" } }; });
  await w.completed(point!.visit, output("confirmed")); await expect(w.advance()).rejects.toThrow(); const result = await w.finish(); expect(result.status).toBe("CANCELLED"); expect(result.stepOutputs).toEqual({ "each/0/read": output("confirmed") }); expect(result.valueOutputs?.each).toBeUndefined();
});
test("cancellation with unacknowledged intent is UNKNOWN, never a false safe terminal cancellation", async () => {
  const s = await setup(), w = s.worker(); await w.advance(); const point = await w.advance(); await w.dispatchIntent(point!.visit, role);
  await s.repository.mutate(state => { state.executions.run!.readProgress!.cancellation = { requestedAt: new Date().toISOString(), requestedBy: { id: "actor", name: "Actor" } }; });
  const result = await w.finish(); expect(result.status).toBe("RECOVERY_REQUIRED"); expect(result.readProgress!.attempts[point!.visit.invocationId]!.status).toBe("UNKNOWN"); await expect(w.completed(point!.visit, output("late"))).rejects.toThrow();
});
test.each([false, true])("failed action before intent=%s is not replayed and retains prior item evidence", async entered => {
  const s = await setup(), w = s.worker(); await w.advance(); await perform(w, "A"); await w.advance(); const point = await w.advance(); if (entered) await w.dispatchIntent(point!.visit, role);
  await w.failed(point!.visit); await expect(w.advance()).rejects.toThrow(); const result = await w.finish(true); expect(result.status).toBe(entered ? "RECOVERY_REQUIRED" : "FAILED"); expect(result.stepOutputs).toEqual({ "each/0/read": output("A") }); expect(result.valueOutputs?.each).toBeUndefined();
});
test("a tool-reported error is a failed receipt, not downstream data or a successful collection item", async () => {
  const s = await setup(), w = s.worker(); await w.advance(); const point = await w.advance(); await w.dispatchIntent(point!.visit, role); await w.completed(point!.visit, { ...output("error"), isError: true });
  await expect(w.advance()).rejects.toThrow(); const result = await w.finish(true); expect(result.status).toBe("FAILED"); expect(result.stepOutputs).toBeUndefined(); expect(result.valueOutputs).toBeUndefined(); expect((await s.repository.snapshot()).timelines.run!.find(value => value.attemptId === result.readProgress!.attempts[point!.visit.invocationId]!.id)!.output).toMatchObject({ isError: true });
});

test.each([false, true])("storage acknowledgement loss committed=%s fences further boundaries; restart reloads exact receipts without replay", async committed => {
  const persist = new Persistence(), s = await setup(source(), { rows: ["a", "b"] }, persist), w = s.worker(); await w.advance(); await perform(w, "A"); await w.advance(); const point = await w.advance(); await w.dispatchIntent(point!.visit, role);
  persist.fail = true; persist.committedLoss = committed; await expect(w.completed(point!.visit, output("B"))).rejects.toThrow(); await expect(w.advance()).rejects.toThrow();
  const reloaded = await Repository.open(persist); await reconcileInterruptedExecutions(reloaded);
  const recovered = (await reloaded.snapshot()).executions.run!; expect(recovered.status).toBe("RECOVERY_REQUIRED"); expect(recovered.stepOutputs?.["each/0/read"]).toEqual(output("A")); expect(recovered.stepOutputs?.["each/1/read"]).toEqual(committed ? output("B") : undefined); expect(recovered.readProgress!.attempts["each/1/read"]!.status).toBe(committed ? "DONE" : "UNKNOWN");
  expect(recovered.iterationProgress!.interruptedAt).toBeTruthy(); await expect(s.worker(reloaded).advance()).rejects.toThrow(); await expect(s.worker(reloaded, s.input, 2).advance()).rejects.toThrow();
});

test("restart marks a prepared item not-dispatched, retains completed items and includes exact identity in recovery events", async () => {
  const s = await setup(), w = s.worker(); await w.advance(); await perform(w, "A"); await w.advance(); await w.advance(); await reconcileInterruptedExecutions(s.repository);
  const state = await s.repository.snapshot(); expect(state.executions.run!.readProgress!.attempts["each/1/read"]!.status).toBe("FAILED"); expect(state.executions.run!.stepOutputs?.["each/0/read"]).toEqual(output("A"));
  expect(state.executionEvents.run!.find(value => value.type === "node.interrupted")!.payload).toMatchObject({ invocationId: "each/1/read", iterations: [{ loopId: "each", index: 1 }], outcome: "NOT_DISPATCHED" });
});

test("finish cannot bypass an unconfirmed collection item or aggregate even when all action answers exist", async () => {
  const s = await setup(), w = s.worker(); await w.advance(); await perform(w, "A"); await w.advance(); await perform(w, "B"); await expect(w.finish()).rejects.toThrow(); expect((await s.get()).status).toBe("RUNNING"); await drain(w); expect((await w.finish()).status).toBe("DONE");
});
test("ledger refuses weak binding keys, changed input schemas and unbounded private input", async () => {
  const s = await setup(); expect(() => newReadIterationLedger("run", s.plan, s.input, role, "weak")).toThrow(); expect(() => newReadIterationLedger("run", s.plan, { large: "x".repeat(64000) }, role, key)).toThrow();
  const src = source(); src.trigger.config = { inputSchema: { type: "object", properties: { rows: array }, required: ["rows"], additionalProperties: false } }; const plan = compileReadWorkflow(stringify(src), [tool], role); expect(() => newReadIterationLedger("run", plan, { rows: [1] }, role, key)).toThrow();
});

test("an early root return retains false and explicitly skips a later collection declaration without inspecting its input", async () => {
  const src = source(); src.metadata.controlFlow.root.nodes.unshift({ kind: "return", id: "early", output: { schema: { type: "boolean" }, value: { kind: "literal", value: false } } });
  const s = await setup(src, {}), points = await drain(s.worker()); expect(points.map(point => point.kind)).toEqual(["return", "skip"]); const done = await s.worker().finish(); expect(done.finalOutput).toBe(false); expect(done.iterationProgress!.receipts["collection:each"]).toBeUndefined(); expect(done.readProgress!.attempts.read!.status).toBe("SKIPPED");
});
test("missing concrete action arguments are saved as not-dispatched failure, never defaulted or promoted into an intent", async () => {
  const src = source(); src.steps[0].parameters.id = "{{input.missing}}"; const s = await setup(src), w = s.worker(); await w.advance(); const point = await w.advance(); expect(point).toMatchObject({ kind: "action", valid: false }); expect(point!.arguments).toBeUndefined(); await expect(w.dispatchIntent(point!.visit, role)).rejects.toThrow(); expect((await w.finish(true)).status).toBe("FAILED");
});
test("completed traversal cannot certify a changed final answer", async () => {
  const s = await setup(), w = s.worker(); await drain(w); await s.repository.mutate(state => { state.executions.run!.finalOutput = ["forged"]; }); await expect(w.finish()).rejects.toThrow(); expect((await s.get()).status).toBe("RUNNING");
});
test("the maximum declared collection size retains every bounded invocation and aggregate", async () => {
  const src = source(); src.metadata.controlFlow.root.nodes[0].maxItems = 100;
  const s = await setup(src, { rows: Array.from({ length: 100 }, (_value, index) => `invoice-${index}`) }); await drain(s.worker()); const done = await s.worker().finish();
  expect(done.status).toBe("DONE"); expect(Object.keys(done.readProgress!.attempts)).toHaveLength(100); expect(done.finalOutput).toHaveLength(100); expect(done.stepOutputs?.["each/99/read"]).toEqual(output("INVOICE-99"));
}, 30000);
test("an aborted worker cannot prepare or authorize a new action, but may retain an already confirmed response", async () => {
  const s = await setup(), controller = new AbortController(), w = new ReadIterationCheckpoints(s.repository, "run", 1, s.yaml, s.plan, s.input, [tool], key, controller.signal);
  await w.advance(); const point = await w.advance(); await w.dispatchIntent(point!.visit, role); controller.abort(); await w.completed(point!.visit, output("confirmed")); await expect(w.advance()).rejects.toThrow(); expect((await w.finish()).status).toBe("CANCELLED");
});

test("an authenticated incremental cursor accepts each confirmed boundary once and never reinterprets its completed prefix", async () => {
  const spy = vi.spyOn(ReadMachine.prototype, "accept"), legacy = vi.spyOn(interpreter, "interpretReadPlan");
  try {
    const s = await setup(), w = s.worker(); await w.advance(); const point = await w.advance(); expect(spy).toHaveBeenCalledTimes(1);
    await w.dispatchIntent(point!.visit, role); await w.completed(point!.visit, output("A")); expect(spy).toHaveBeenCalledTimes(1);
    expect(await w.advance()).toMatchObject({ kind: "collection-item", visit: { invocationId: "each/0/each" } }); expect(spy).toHaveBeenCalledTimes(2);
    expect(await w.advance()).toMatchObject({ kind: "action", visit: { invocationId: "each/1/read" }, arguments: { id: "b" } }); expect(spy).toHaveBeenCalledTimes(3); expect(legacy).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); legacy.mockRestore(); }
});

test("a fresh worker restores exact encrypted arguments without relying on another worker's memory", async () => {
  const spy = vi.spyOn(ReadMachine.prototype, "accept"), legacy = vi.spyOn(interpreter, "interpretReadPlan");
  try {
    const s = await setup(), first = s.worker(); await first.advance(); const point = await first.advance(); expect(spy).toHaveBeenCalledTimes(1);
    await s.worker().dispatchIntent(point!.visit, role); expect(spy).toHaveBeenCalledTimes(1);
    await s.worker().completed(point!.visit, output("A")); expect(spy).toHaveBeenCalledTimes(1);
    await drain(s.worker()); expect((await s.worker().finish()).finalOutput).toEqual(["A", "B"]);
    expect(spy).toHaveBeenCalledTimes(7); expect(legacy).not.toHaveBeenCalled();
  } finally { spy.mockRestore(); legacy.mockRestore(); }
});

test.each(["timeline-status", "timeline-output", "timeline-metadata", "duplicate-timeline", "attempt-status", "attempt-metadata", "final", "missing-output", "extra-value"])("a warmed pending proof cannot hide changed %s evidence", async damage => {
  const s = await setup(), w = s.worker(); await w.advance(); await perform(w, "A"); await w.advance(); const point = await w.advance();
  await s.repository.mutate(state => {
    const item = state.executions.run!, entries = state.timelines.run!, entry = entries.find(value => value.invocationId === "each/0/read")!;
    if (damage === "timeline-status") entry.status = "RUNNING";
    if (damage === "timeline-output") entry.output = output("forged");
    if (damage === "timeline-metadata") entry.durationMs = 999;
    if (damage === "duplicate-timeline") entries.push(structuredClone(entry));
    if (damage === "attempt-status") item.readProgress!.attempts[point!.visit.invocationId]!.status = "DONE";
    if (damage === "attempt-metadata") item.readProgress!.attempts[point!.visit.invocationId]!.startedAt = "forged";
    if (damage === "final") item.finalOutput = "forged";
    if (damage === "missing-output") delete item.stepOutputs!["each/0/read"];
    if (damage === "extra-value") item.valueOutputs!.extra = { value: "forged" };
  });
  await expect(w.dispatchIntent(point!.visit, role)).rejects.toThrow(); expect((await s.get()).readProgress!.attempts[point!.visit.invocationId]!.dispatchIntentAt).toBeUndefined();
});

test("volatile actor/cancellation checks run even on a warmed pending proof", async () => {
  const s = await setup(), w = s.worker(); await w.advance(); const point = await w.advance();
  await s.repository.mutate(state => { state.users.actor!.status = "Inactive"; }); await expect(w.dispatchIntent(point!.visit, role)).rejects.toThrow();
  await s.repository.mutate(state => { state.users.actor!.status = "Active"; state.executions.run!.readProgress!.cancellation = { requestedAt: new Date().toISOString(), requestedBy: { id: "actor", name: "Actor" } }; });
  await expect(w.dispatchIntent(point!.visit, role)).rejects.toThrow(); expect((await s.get()).readProgress!.attempts[point!.visit.invocationId]!.status).toBe("PREPARING");
});

test("caller mutations of a returned pending action cannot alter the memo's arguments or scope", async () => {
  const s = await setup(), w = s.worker(); await w.advance(); const point = await w.advance(), visit = structuredClone(point!.visit);
  point!.arguments!.id = "forged"; (point!.visit.iterations as any[])[0].index = 99; point!.dataBinding = "forged";
  await w.dispatchIntent(visit, role); await w.completed(visit, output("A")); await drain(w); expect((await w.finish()).finalOutput).toEqual(["A", "B"]);
});

test.each(["empty", "nested", "branches", "early-return", "null-values"])("warm and reconstructed workers have the same %s traversal and saved semantic evidence", async scenario => {
  const src = source(); let input: Record<string, unknown> = { rows: ["a", "b"] };
  const loop = src.metadata.controlFlow.root.nodes[0], answer = src.metadata.controlFlow.root.nodes[1];
  if (scenario === "empty") input.rows = [];
  if (scenario === "nested") {
    loop.items.schema = { type: "array", items: array }; input.rows = [["a"], ["b", "c"]];
    loop.body = seq({ kind: "foreach", id: "inner", items: { schema: array, value: ref("each", ["item"]) }, maxItems: 3, body: seq(action("read")), collect: loop.collect });
    loop.collect = { schema: array, value: ref("inner", ["value"]) }; src.steps[0].parameters.id = "{{inner.item}}"; answer.output.schema = { type: "array", items: array };
  }
  if (scenario === "branches") {
    loop.body = seq({ kind: "if", id: "gate", predicate: { kind: "ref", source: "workflowInput", path: ["enabled"] }, then: seq(action("read")), else: seq(), merge: { schema: { type: "string" }, then: ref("read", ["structuredContent", "id"]), else: ref("each", ["item"]) } });
    loop.collect.value = ref("gate", ["value"]); input.enabled = false;
  }
  if (scenario === "early-return") src.metadata.controlFlow.root.nodes.unshift({ kind: "return", id: "early", output: { schema: { type: "boolean" }, value: { kind: "literal", value: false } } });
  if (scenario === "null-values") { loop.collect = { schema: { type: "null" }, value: { kind: "literal", value: null } }; answer.output.schema = { type: "array", items: { type: "null" } }; }
  const warm = await setup(src, input), cold = await setup(src, input), worker = warm.worker(), warmPoints = await drain(worker), coldPoints: IterationBoundary[] = [];
  for (let index = 0; index < 100; index++) {
    const point = await cold.worker().advance(); if (!point) break; coldPoints.push(point);
    if (point.kind === "action") { await cold.worker().dispatchIntent(point.visit, role); await cold.worker().completed(point.visit, output(String(point.arguments!.id).toUpperCase())); }
  }
  expect(coldPoints).toEqual(warmPoints);
  const project = (item: Execution) => ({ status: item.status, final: item.finalOutput, outputs: item.stepOutputs, values: item.valueOutputs,
    receipts: Object.entries(item.iterationProgress!.receipts).map(([address, { recordedAt: _time, seal: _seal, attemptId: _id, ...receipt }]) => [address, receipt]),
    attempts: Object.values(item.readProgress!.attempts).map(({ id: _id, startedAt: _start, completedAt: _end, dispatchIntentAt: _intent, ...attempt }) => attempt) });
  expect(project(await cold.worker().finish())).toEqual(project(await worker.finish()));
});

test("captured indexes and proof caches do not trust later mutations of constructor inputs", async () => {
  const s = await setup(), plan = structuredClone(s.plan), input = structuredClone(s.input), tools = [structuredClone(tool)];
  const w = new ReadIterationCheckpoints(s.repository, "run", 1, s.yaml, plan, input, tools, key);
  input.rows = ["forged"]; (plan.ir.flow!.nodes[0] as any).maxItems = 0; tools[0]!.input_schema = { type: "null" }; plan.semanticHash = "forged";
  await drain(w); expect((await w.finish()).finalOutput).toEqual(["A", "B"]);
});

test("a mutated public source property cannot combine with a changed snapshot to bypass the captured hash", async () => {
  const s = await setup(), w = s.worker(); await w.advance(); const changed = s.yaml.replace("Read bounded invoices", "Forged source");
  (w as any).yaml = changed;
  await s.repository.mutate(state => { state.executions.run!.workflowSnapshot!.yaml = changed; });
  await expect(w.advance()).rejects.toThrow(); expect((await s.get()).readProgress!.attempts).toEqual({});
});

test("selected evidence restores authenticated private scopes without a write, semantic replay or dispatch grant", async () => {
  const s = await setup(), w = s.worker(); await w.advance(); await perform(w, "A"); await w.advance(); const point = await w.advance();
  const before = await s.repository.snapshot(), spy = vi.spyOn(interpreter, "interpretReadPlan");
  try {
    const evidence = await w.selectedEvidence(point!.visit); expect(spy).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({ profile: "read-selected-evidence/v1", executionId: "run", epoch: 1, sourceHash: s.plan.sourceHash, semanticHash: s.plan.semanticHash, actorId: "actor", admittedRole: role, nodeId: "read", sourceIndex: 0, args: { id: "b" }, prior: [] });
    expect(JSON.stringify(evidence)).not.toContain(key); expect(JSON.stringify(evidence)).not.toContain("never-persist-this-input-secret");
    evidence.args.id = "forged"; expect((await w.selectedEvidence(point!.visit)).args).toEqual({ id: "b" }); expect(await s.repository.snapshot()).toEqual(before);
  } finally { spy.mockRestore(); }
});

test("only fully confirmed item/aggregate receipts expose all concrete body reads to the next root action", async () => {
  const src = source(); src.steps.push({ id: "after", action: "read", parameters: { id: "after" } }); src.metadata.controlFlow.root.nodes.splice(1, 0, action("after"));
  const s = await setup(src), w = s.worker(); let point: IterationBoundary | null = null;
  for (let index = 0; index < 20; index++) { point = await w.advance(); if (point?.nodeId === "after") break; if (point?.kind === "action") { await w.dispatchIntent(point.visit, role); await w.completed(point.visit, output(String(point.arguments!.id))); } }
  expect(point).toMatchObject({ kind: "action", nodeId: "after" }); const before = await s.repository.snapshot();
  const evidence = await w.selectedEvidence(point!.visit); expect(evidence.prior.map(item => [item.sourceIndex, item.visit.invocationId, item.args])).toEqual([[0, "each/0/read", { id: "a" }], [0, "each/1/read", { id: "b" }]]);
  expect(evidence.attemptId).toBe((await s.get()).readProgress!.attempts.after!.id); expect(await s.repository.snapshot()).toEqual(before);
  await s.repository.mutate(state => { delete state.executions.run!.iterationProgress!.receipts["collection:each"]; }); await expect(w.selectedEvidence(point!.visit)).rejects.toThrow();
});

test.each(["cancel", "disabled", "wrong-visit", "dispatched", "interrupted", "output"])("selected evidence refuses %s even after the pending proof is warmed", async damage => {
  const s = await setup(), w = s.worker(); await w.advance(); await perform(w, "A"); await w.advance(); const point = await w.advance();
  if (damage === "dispatched") await w.dispatchIntent(point!.visit, role);
  if (damage === "interrupted") await reconcileInterruptedExecutions(s.repository);
  if (["cancel", "disabled", "output"].includes(damage)) await s.repository.mutate(state => {
    if (damage === "cancel") state.executions.run!.readProgress!.cancellation = { requestedAt: new Date().toISOString(), requestedBy: { id: "actor", name: "Actor" } };
    if (damage === "disabled") state.users.actor!.status = "Inactive";
    if (damage === "output") state.executions.run!.stepOutputs!["each/0/read"] = output("forged");
  });
  const target = damage === "wrong-visit" ? { invocationId: "each/0/read", iterations: [{ loopId: "each", index: 0 }] } : point!.visit;
  await expect(w.selectedEvidence(target)).rejects.toThrow();
});

test("uncertain storage acknowledgement fences selected evidence even when the local pending snapshot still looks valid", async () => {
  const persist = new Persistence(), s = await setup(source(), { rows: ["a"] }, persist), w = s.worker(); await w.advance(); const point = await w.advance();
  persist.fail = true; await expect(s.repository.mutate(state => { state.workflows.flow!.name = "Unacknowledged update"; })).rejects.toThrow();
  await expect(w.selectedEvidence(point!.visit)).rejects.toThrow(); expect((await s.get()).readProgress!.attempts[point!.visit.invocationId]!.status).toBe("PREPARING");
});

test.each(["tamper", "stale", "other-run", "malformed", "null", "undefined", "actor", "publication", "registry"])("a private %s continuation cannot authorize dispatch, even on a warmed worker", async damage => {
  const s = await setup(), worker = s.worker(); await worker.advance(); const old = (await s.repository.snapshot()).readContinuations.run!;
  const point = await worker.advance();
  const other = await setup(source(), s.input, null, "other-run"); await other.worker().advance();
  const crossRun = (await other.repository.snapshot()).readContinuations["other-run"]!;
  await s.repository.mutate(state => {
    const record = state.readContinuations.run!;
    if (damage === "tamper") { const bytes = Buffer.from(record.ciphertext, "base64"); bytes[30] = bytes[30]! ^ 1; record.ciphertext = bytes.toString("base64"); }
    if (damage === "stale") state.readContinuations.run = old;
    if (damage === "other-run") state.readContinuations.run = { ...crossRun, executionId: "run" };
    if (damage === "malformed") record.ciphertext = "not-encrypted";
    if (damage === "null") state.readContinuations.run = null as never;
    if (damage === "undefined") state.readContinuations.run = undefined as never;
    if (damage === "actor") state.executions.run!.startedBy.id = "changed";
    if (damage === "publication") state.executions.run!.workflowSnapshot!.version++;
    if (damage === "registry") state.executions.run!.workflowSnapshot!.registryHash = "changed";
  });
  await expect(worker.dispatchIntent(point!.visit, role)).rejects.toThrow(); await expect(s.worker().selectedEvidence(point!.visit)).rejects.toThrow();
  expect((await s.get()).readProgress!.attempts[point!.visit.invocationId]!.dispatchIntentAt).toBeUndefined();
});

test("reordering object members does not change complete-evidence identity; reordering timeline entries does", async () => {
  const s = await setup(), worker = s.worker(); await worker.advance(); await perform(worker, "A"); await worker.advance(); const point = await worker.advance();
  const reverse = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).reverse());
  await s.repository.mutate(state => {
    const item = state.executions.run!; item.iterationProgress!.receipts = reverse(item.iterationProgress!.receipts) as any;
    item.readProgress!.attempts = reverse(item.readProgress!.attempts) as any; item.stepOutputs = reverse(item.stepOutputs!);
    state.timelines.run = state.timelines.run!.map(entry => reverse(entry));
  });
  expect((await s.worker().selectedEvidence(point!.visit)).args).toEqual({ id: "b" });
  await s.repository.mutate(state => { state.timelines.run!.reverse(); }); await expect(worker.dispatchIntent(point!.visit, role)).rejects.toThrow();
});

test("an absent legacy cursor reconstructs only saved receipts without repeating any confirmed SDK action", async () => {
  const s = await setup(), worker = s.worker(); await worker.advance(); await perform(worker, "A"); await worker.advance();
  await s.repository.mutate(state => { delete state.readContinuations.run; });
  const point = await s.worker().advance(); expect(point).toMatchObject({ kind: "action", visit: { invocationId: "each/1/read" }, arguments: { id: "b" } });
  expect((await s.get()).stepOutputs).toEqual({ "each/0/read": output("A") }); expect((await s.repository.snapshot()).readContinuations.run).toBeDefined();
});

test("a missing cursor cannot skip an earlier missing receipt or fabricate an answer", async () => {
  const s = await setup(), worker = s.worker(); await worker.advance(); await perform(worker, "A"); await worker.advance();
  await s.repository.mutate(state => { delete state.readContinuations.run; delete state.executions.run!.iterationProgress!.receipts["collection:each"]; });
  await expect(s.worker().advance()).rejects.toThrow(); expect((await s.get()).stepOutputs).toEqual({ "each/0/read": output("A") });
});

test("terminal completion deletes the private cursor while retaining public receipt and answer evidence", async () => {
  const s = await setup(), worker = s.worker(); await drain(worker); expect((await s.repository.snapshot()).readContinuations.run).toBeDefined();
  const done = await worker.finish(); expect(done.finalOutput).toEqual(["A", "B"]); expect((await s.repository.snapshot()).readContinuations.run).toBeUndefined();
  expect(JSON.stringify(done)).not.toContain("ciphertext"); expect(JSON.stringify(done)).not.toContain("never-persist-this-input-secret");
});

test("durable nested reconstruction exposes completed child reads only to their enclosing item until the outer aggregate confirms", async () => {
  const src = source(), outer = src.metadata.controlFlow.root.nodes[0]; outer.items.schema = { type: "array", items: array };
  outer.body = seq({ kind: "foreach", id: "inner", items: { schema: array, value: ref("each", ["item"]) }, maxItems: 3, body: seq(action("read")), collect: outer.collect }, action("inside"));
  outer.collect = { schema: array, value: ref("inner", ["value"]) }; src.steps[0].parameters.id = "{{inner.item}}";
  src.steps.push({ id: "inside", action: "read", parameters: { id: "{{input.summary}}" } }, { id: "after", action: "read", parameters: { id: "after" } }); src.metadata.controlFlow.root.nodes.splice(1, 0, action("after")); src.metadata.controlFlow.root.nodes[2].output.schema = { type: "array", items: array };
  const s = await setup(src, { rows: [["a"], ["b"]], summary: "summary" }), w = s.worker(), selected: Record<string, string[]> = {};
  for (let index = 0; index < 50; index++) { const point = await w.advance(); if (!point) break; if (point.kind === "action") { selected[point.visit.invocationId] = (await w.selectedEvidence(point.visit)).prior.map(item => item.visit.invocationId); await w.dispatchIntent(point.visit, role); await w.completed(point.visit, output(String(point.arguments!.id).toUpperCase())); } }
  expect(selected).toEqual({ "each/0/inner/0/read": [], "each/0/inside": ["each/0/inner/0/read"], "each/1/inner/0/read": [], "each/1/inside": ["each/1/inner/0/read"], after: ["each/0/inner/0/read", "each/0/inside", "each/1/inner/0/read", "each/1/inside"] }); expect((await w.finish()).finalOutput).toEqual([["A"], ["B"]]);
});

test("durable branch reconstruction omits skipped prerequisites and never borrows the preceding item's reads", async () => {
  const src = source(), loop = src.metadata.controlFlow.root.nodes[0]; loop.items.schema = { type: "array", items: { type: "object", properties: { id: { type: "string" }, enabled: { type: "boolean" } }, required: ["id", "enabled"], additionalProperties: false } };
  loop.body = seq({ kind: "if", id: "gate", predicate: ref("each", ["item", "enabled"]), then: seq(action("read")), else: seq(), merge: { schema: { type: "string" }, then: ref("read", ["structuredContent", "id"]), else: ref("each", ["item", "id"]) } }, action("dependent")); loop.collect.value = ref("dependent", ["structuredContent", "id"]);
  src.steps[0].parameters.id = "{{each.item.id}}"; src.steps.push({ id: "dependent", action: "read", parameters: { id: "{{gate.value}}" } }, { id: "after", action: "read", parameters: { id: "after" } }); src.metadata.controlFlow.root.nodes.splice(1, 0, action("after"));
  const s = await setup(src, { rows: [{ id: "a", enabled: true }, { id: "b", enabled: false }] }), w = s.worker(), selected: Record<string, string[]> = {};
  for (let index = 0; index < 50; index++) { const point = await w.advance(); if (!point) break; if (point.kind === "action") { selected[point.visit.invocationId] = (await w.selectedEvidence(point.visit)).prior.map(item => item.visit.invocationId); await w.dispatchIntent(point.visit, role); await w.completed(point.visit, output(String(point.arguments!.id).toUpperCase())); } }
  expect(selected).toEqual({ "each/0/read": [], "each/0/dependent": ["each/0/read"], "each/1/dependent": [], after: ["each/0/read", "each/0/dependent", "each/1/dependent"] }); expect((await w.finish()).finalOutput).toEqual(["A", "B"]);
});

test.each(["arguments", "attempt", "input", "actor", "role", "epoch", "visit", "source-index", "semantic", "source", "prior"])("dispatch intent atomically rejects changed selected %s evidence", async change => {
  const s = await setup(), w = s.worker(); await w.advance(); const point = (await w.advance())!, selected = await w.selectedEvidence(point.visit);
  if (change === "arguments") selected.args.id = "changed";
  if (change === "attempt") selected.attemptId = "changed";
  if (change === "input") selected.inputBinding = "changed";
  if (change === "actor") selected.actorId = "changed";
  if (change === "role") selected.admittedRole = "changed";
  if (change === "epoch") selected.epoch++;
  if (change === "visit") selected.visit.iterations[0]!.index++;
  if (change === "source-index") selected.sourceIndex++;
  if (change === "semantic") selected.semanticHash = "changed";
  if (change === "source") selected.sourceHash = "changed";
  if (change === "prior") selected.prior = [{ nodeId: "read", sourceIndex: 0, args: { id: "invented" }, visit: { invocationId: "other/0/read", iterations: [{ loopId: "other", index: 0 }] } }];
  const before = await s.repository.snapshot(); await expect(w.dispatchIntent(point.visit, role, { selectedEvidence: selected, assertContext: () => {} })).rejects.toThrow();
  expect(await s.repository.snapshot()).toEqual(before);
});

test("a current selected evidence intent checks synchronous context twice inside its repository transaction", async () => {
  const s = await setup(), w = s.worker(); await w.advance(); const point = (await w.advance())!, selected = await w.selectedEvidence(point.visit), checked: string[] = [];
  await w.dispatchIntent(point.visit, role, { selectedEvidence: selected, assertContext: state => { checked.push(state.executions.run!.readProgress!.attempts[point.visit.invocationId]!.status); } });
  expect(checked).toEqual(["PREPARING", "PREPARING"]); expect((await s.get()).readProgress!.attempts[point.visit.invocationId]!.status).toBe("DISPATCH_INTENT");
});

test("a revoked synchronous context at intent or automatic boundary never writes a receipt", async () => {
  const s = await setup(), w = s.worker(), before = await s.repository.snapshot(); const deny = () => { throw new Error("Current publication revoked"); };
  await expect(w.advance(deny)).rejects.toThrow(); expect(await s.repository.snapshot()).toEqual(before);
  await w.advance(); const point = (await w.advance())!, selected = await w.selectedEvidence(point.visit), prepared = await s.repository.snapshot();
  await expect(w.dispatchIntent(point.visit, role, { selectedEvidence: selected, assertContext: deny })).rejects.toThrow(); expect(await s.repository.snapshot()).toEqual(prepared);
});

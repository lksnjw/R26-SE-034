import { afterEach, expect, test, vi } from "vitest";
import { boundedReadFixture, TaskRecords } from "./fixtures/bounded-read-task.js";
import { assertReadTaskOutbox, dispatchReadTaskOutbox, recoverReadTaskOutboxes, readTaskCommandSchema } from "../src/runner/read-task-outbox.js";
import { readJobQueue } from "../src/runner/read-jobs.js";
import { publicExecution } from "../src/redact/public-model-usage.js";
import { splitFirestoreState, assembleFirestoreState } from "../src/storage/firestore-record-layout.js";

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(closers.splice(0).reverse().map(close => close())); });
async function setup(options: Parameters<typeof boundedReadFixture>[0] = {}) {
  const f = await boundedReadFixture(options); closers.push(f.close);
  const publication = await f.publish(); expect(publication.statusCode, publication.body).toBe(200);
  return f;
}

test("HTTP read admission commits a private outbox before queue entry, but never executes on readiness or return", async () => {
  const f = await setup();
  f.enqueue.mockImplementation(async command => {
    const state = await f.repository.snapshot(), job = state.readJobs[command.executionId]!;
    expect(assertReadTaskOutbox(job)).toMatchObject({ state: "ENQUEUE_INTENT", attempts: 1, taskId: command.taskId });
    expect(state.executions[command.executionId]!.status).toBe("PENDING");
    return { taskId: command.taskId, outcome: "CREATED" };
  });
  const response = await f.run(); expect(response.statusCode, response.body).toBe(202);
  expect(response.json().meta.taskDispatch).toBe("ENQUEUED");
  await new Promise<void>(done => setImmediate(done));
  expect(f.sdk.callTool).not.toHaveBeenCalled();
  const state = await f.repository.snapshot(), job = state.readJobs[response.json().data.id]!;
  expect(assertReadTaskOutbox(job).state).toBe("ENQUEUED");
  expect(JSON.stringify(publicExecution(state.executions[job.executionId]!))).not.toContain("taskDispatchSecret");
  expect(assembleFirestoreState(splitFirestoreState(state))).toEqual(state);
  const again = await f.run(); expect(again.json().data.id).toBe(job.executionId); expect(f.enqueue).toHaveBeenCalledTimes(1);
});

test("enqueue acknowledgement loss retains one original task identity and recovers without ERP calls", async () => {
  const f = await setup(); f.enqueue.mockRejectedValueOnce(new Error("Synthetic lost queue ACK"));
  const response = await f.run(); expect(response.statusCode, response.body).toBe(202);
  expect(response.json().meta.taskDispatch).toBe("PENDING");
  const id = response.json().data.id, original = (await f.repository.snapshot()).readJobs[id]!.taskDispatchSecret!;
  expect(original.state).toBe("ENQUEUE_INTENT");
  f.enqueue.mockImplementation(async command => ({ taskId: command.taskId, outcome: "ALREADY_EXISTS" }));
  expect(await recoverReadTaskOutboxes(f.repository)).toEqual({ inspected: 1, pending: 0 });
  const saved = (await f.repository.snapshot()).readJobs[id]!.taskDispatchSecret!;
  expect(saved).toMatchObject({ state: "ENQUEUED", attempts: 2, taskId: original.taskId });
  expect(f.sdk.callTool).not.toHaveBeenCalled(); expect(Object.keys((await f.repository.snapshot()).executions)).toEqual([id]);
});

test.each([false, true])("admission storage ACK loss (committed=%s) never enqueues from unacknowledged local state", async committed => {
  const storage = new TaskRecords(), f = await setup({ storage });
  storage.commitBeforeFailure = committed; storage.failWhen = state => Object.values(state.readJobs).some(job => job.taskDispatchSecret?.state === "PREPARED");
  const response = await f.run(); expect(response.statusCode).toBe(500);
  expect(f.enqueue).not.toHaveBeenCalled(); expect(f.sdk.callTool).not.toHaveBeenCalled();
  await f.close(); closers.splice(closers.indexOf(f.close), 1);
  const reopened = await boundedReadFixture({ storage }); closers.push(reopened.close);
  expect(await recoverReadTaskOutboxes(reopened.repository)).toEqual({ inspected: committed ? 1 : 0, pending: 0 });
  expect(reopened.enqueue).toHaveBeenCalledTimes(committed ? 1 : 0); expect(reopened.sdk.callTool).not.toHaveBeenCalled();
});

test.each([false, true])("enqueue intent storage ACK loss (committed=%s) never enters queue until authoritative reopen", async committed => {
  const storage = new TaskRecords(), f = await setup({ storage });
  storage.commitBeforeFailure = committed; storage.failWhen = state => Object.values(state.readJobs).some(job => job.taskDispatchSecret?.state === "ENQUEUE_INTENT");
  const response = await f.run(); expect(response.statusCode).toBe(500); expect(f.enqueue).not.toHaveBeenCalled();
  await f.close(); closers.splice(closers.indexOf(f.close), 1);
  const reopened = await boundedReadFixture({ storage }); closers.push(reopened.close);
  expect(await recoverReadTaskOutboxes(reopened.repository)).toEqual({ inspected: 1, pending: 0 }); expect(reopened.enqueue).toHaveBeenCalledTimes(1);
});

test.each([false, true])("queue acceptance checkpoint ACK loss (committed=%s) reconciles without a different task or business replay", async committed => {
  const storage = new TaskRecords(), f = await setup({ storage });
  storage.commitBeforeFailure = committed; storage.failWhen = state => Object.values(state.readJobs).some(job => job.taskDispatchSecret?.state === "ENQUEUED");
  const response = await f.run(); expect(response.statusCode).toBe(503); expect(f.enqueue).toHaveBeenCalledTimes(1);
  const sent = f.enqueue.mock.calls[0]![0];
  await f.close(); closers.splice(closers.indexOf(f.close), 1);
  const reopened = await boundedReadFixture({ storage, enqueue: async command => { expect(command).toEqual(sent); return { taskId: command.taskId, outcome: "ALREADY_EXISTS" }; } }); closers.push(reopened.close);
  expect(await recoverReadTaskOutboxes(reopened.repository)).toEqual({ inspected: committed ? 0 : 1, pending: 0 });
  expect(reopened.sdk.callTool).not.toHaveBeenCalled(); expect(Object.keys((await reopened.repository.snapshot()).executions)).toEqual([sent.executionId]);
});

test("late ignored-cancellation enqueue cannot mark an abandoned wait accepted", async () => {
  let release!: (value: { taskId: string; outcome: "CREATED" }) => void;
  const f = await setup({ timeoutMs: 10, enqueue: () => new Promise(resolve => { release = resolve; }) });
  const response = await f.run(); expect(response.statusCode).toBe(202); expect(response.json().meta.taskDispatch).toBe("PENDING");
  const command = f.enqueue.mock.calls[0]![0]; release({ taskId: command.taskId, outcome: "CREATED" });
  await new Promise<void>(done => setImmediate(done));
  expect((await f.repository.snapshot()).readJobs[command.executionId]!.taskDispatchSecret!.state).toBe("ENQUEUE_INTENT");
  expect(f.enqueue.mock.calls[0]![1].aborted).toBe(true); expect(f.sdk.callTool).not.toHaveBeenCalled();
});

test.each(["wrong-name", "unknown-outcome", "extra-field"])("invalid %s queue acknowledgement never manufactures acceptance", async field => {
  const f = await setup(); f.enqueue.mockImplementation(async command => ({ taskId: field === "wrong-name" ? "wrong" : command.taskId,
    outcome: field === "unknown-outcome" ? "SUCCESS" : "CREATED", ...(field === "extra-field" ? { actor: "admin" } : {}) } as never));
  const response = await f.run(); expect(response.statusCode).toBe(202); expect(response.json().meta.taskDispatch).toBe("PENDING");
});

test("only awaited task execution runs the pinned read, and duplicate delivery cannot repeat it", async () => {
  const f = await setup(), response = await f.run(); expect(response.statusCode, response.body).toBe(202);
  const id = response.json().data.id, command = f.sent[0]!;
  const diagnostics: string[] = [], read = f.repository.readAuthoritative.bind(f.repository);
  vi.spyOn(f.repository, "readAuthoritative").mockImplementation(async reader => {
    try { return await read(reader); } catch (error) { diagnostics.push(error instanceof Error ? error.message : "fixture failure"); throw error; }
  });
  const saved = await readJobQueue(f.services).executeTask(command, { timeoutMs: 1000 });
  expect(saved.status, JSON.stringify({ diagnostics, failure: saved.failure, outputs: saved.stepOutputs, discovered: f.sdk.listTools.mock.calls.length })).toBe("DONE"); expect(f.sdk.callTool).toHaveBeenCalledTimes(2);
  expect(saved.stepOutputs!.first).toMatchObject({ structuredContent: { value: "acknowledged synthetic read" } });
  const before = await f.repository.snapshot();
  expect((await readJobQueue(f.services).executeTask(command, { timeoutMs: 1000 })).status).toBe("DONE");
  expect(await f.repository.snapshot()).toEqual(before); expect(f.sdk.callTool).toHaveBeenCalledTimes(2);
  const events = await f.app.inject({ method: "GET", url: `/api/executions/${id}/events?waitMs=0`, headers: f.headers });
  expect(events.statusCode).toBe(200); expect(events.json().data.status).toBe("DONE");
});

test("new repository and session reopen uses the same acknowledged task and saved publication", async () => {
  const storage = new TaskRecords(), f = await setup({ storage }), response = await f.run(), command = f.sent[0]!;
  expect(response.statusCode).toBe(202);
  await f.close(); closers.splice(closers.indexOf(f.close), 1);
  const reopened = await boundedReadFixture({ storage, configure: false }); closers.push(reopened.close);
  expect((await readJobQueue(reopened.services).executeTask(command, { timeoutMs: 1000 })).status).toBe("DONE");
  expect(reopened.sdk.callTool).toHaveBeenCalledTimes(2); expect(reopened.enqueue).not.toHaveBeenCalled();
});

test("forged task identity and extra actor authority cannot claim or execute", async () => {
  const f = await setup(); await f.run(); const before = await f.repository.snapshot();
  for (const command of [{ ...f.sent[0], taskId: `read-${"f".repeat(64)}` }, { ...f.sent[0], actorId: "admin" }])
    await expect(readJobQueue(f.services).executeTask(command, { timeoutMs: 1000 })).rejects.toThrow();
  expect(await f.repository.snapshot()).toEqual(before); expect(f.sdk.callTool).not.toHaveBeenCalled();
  expect(readTaskCommandSchema.safeParse({ ...f.sent[0], approval: true }).success).toBe(false);
});

test("revoked requester is checked again after delivery, before ERP entry", async () => {
  const f = await setup(); await f.run(); await f.repository.mutate(state => { state.users.owner!.status = "Suspended"; });
  const result = await readJobQueue(f.services).executeTask(f.sent[0], { timeoutMs: 1000 });
  expect(result.status).toBe("FAILED"); expect(f.sdk.callTool).not.toHaveBeenCalled();
});

test("task cancellation before claim never grants a worker or dispatch authority", async () => {
  const f = await setup(); await f.run(); const before = await f.repository.snapshot(), controller = new AbortController(); controller.abort();
  await expect(readJobQueue(f.services).executeTask(f.sent[0], { timeoutMs: 1000, signal: controller.signal })).rejects.toThrow();
  expect(await f.repository.snapshot()).toEqual(before); expect(f.sdk.callTool).not.toHaveBeenCalled();
});

test("deadline during an ignored-cancellation SDK call retires unknown evidence and never executes the next node", async () => {
  const f = await setup(); await f.run(); let release!: (value: unknown) => void;
  f.sdk.callTool.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const result = await readJobQueue(f.services).executeTask(f.sent[0], { timeoutMs: 100 });
  expect(result.status).toBe("RECOVERY_REQUIRED"); expect(f.sdk.callTool).toHaveBeenCalledTimes(1);
  const before = await f.repository.snapshot(); release({ structuredContent: { value: "late" }, content: [] });
  await new Promise<void>(done => setImmediate(done));
  expect(await f.repository.snapshot()).toEqual(before);
  expect((await readJobQueue(f.services).executeTask(f.sent[0], { timeoutMs: 1000 })).status).toBe("RECOVERY_REQUIRED");
  expect(f.sdk.callTool).toHaveBeenCalledTimes(1);
});

test("unconfigured bounded host rejects new jobs, and outbox recovery is explicitly bounded", async () => {
  const f = await setup({ configure: false }), response = await f.run(); expect(response.statusCode).toBe(503);
  expect(Object.keys((await f.repository.snapshot()).readJobs)).toEqual([]); expect(f.enqueue).not.toHaveBeenCalled();
  for (const limit of [0, 101, NaN]) await expect(recoverReadTaskOutboxes(f.repository, limit)).rejects.toThrow();
  await expect(dispatchReadTaskOutbox(f.repository, "missing")).rejects.toThrow("transport is unavailable");
});

test("duplicate delivery during an active claim cannot acknowledge or repeat the original task", async () => {
  const f = await setup(); await f.run();
  let enter!: () => void, release!: (value: unknown) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  f.sdk.callTool.mockImplementationOnce(() => { enter(); return new Promise(resolve => { release = resolve; }); });
  const command = f.sent[0]!, task = readJobQueue(f.services).executeTask(command, { timeoutMs: 2000 });
  try {
    await entered;
    const before = await f.repository.snapshot();
    await expect(readJobQueue(f.services).executeTask(command, { timeoutMs: 1000 })).rejects.toThrow("unresolved existing claim");
    expect(await f.repository.snapshot()).toEqual(before); expect(f.sdk.callTool).toHaveBeenCalledTimes(1);
  } finally { release({ content: [], structuredContent: { value: "original acknowledged read" } }); }
  expect((await task).status).toBe("DONE"); expect(f.sdk.callTool).toHaveBeenCalledTimes(2);
});

test.each([
  { job: "FINISHED", run: "RUNNING" }, { job: "FINISHED", run: "RECOVERY_REQUIRED" },
  { job: "RECOVERY_REQUIRED", run: "DONE" }, { job: "QUEUED", run: "DONE" },
] as const)("inconsistent $job/$run receipt never acknowledges task completion", async ({ job, run }) => {
  const f = await setup(); await f.run(); const command = f.sent[0]!;
  await f.repository.mutateExecution(command.executionId, state => {
    state.readJobs[command.executionId]!.state = job; state.executions[command.executionId]!.status = run;
  });
  const before = await f.repository.snapshot();
  await expect(readJobQueue(f.services).executeTask(command, { timeoutMs: 1000 })).rejects.toThrow();
  expect(await f.repository.snapshot()).toEqual(before); expect(f.sdk.callTool).not.toHaveBeenCalled();
});

test("a claim lost between lookup and checkpoint cannot return a live run as an acknowledged task", async () => {
  const f = await setup(); await f.run(); const command = f.sent[0]!, checkpoint = f.repository.mutateExecution.bind(f.repository);
  let race = true;
  vi.spyOn(f.repository, "mutateExecution").mockImplementation(async (id, mutation) => {
    if (race) {
      race = false;
      await checkpoint(id, state => { state.readJobs[id]!.state = "CLAIMED"; state.executions[id]!.status = "RUNNING"; });
    }
    return checkpoint(id, mutation);
  });
  await expect(readJobQueue(f.services).executeTask(command, { timeoutMs: 1000 })).rejects.toThrow("no confirmed terminal receipt");
  expect(f.sdk.callTool).not.toHaveBeenCalled();
  expect((await f.repository.snapshot()).executions[command.executionId]!.status).toBe("RUNNING");
});

test("bounded shutdown drains the awaited task, and ignored SDK cancellation cannot write late results", async () => {
  const f = await setup(); await f.run(); let enter!: () => void, release!: (value: unknown) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  f.sdk.callTool.mockImplementation(() => { enter(); return new Promise(resolve => { release = resolve; }); });
  const queue = readJobQueue(f.services), task = queue.executeTask(f.sent[0], { timeoutMs: 2000 });
  await entered; await queue.stop();
  expect((await task).status).toBe("RECOVERY_REQUIRED"); expect(f.sdk.callTool).toHaveBeenCalledTimes(1);
  const before = await f.repository.snapshot(); release({ content: [], structuredContent: { value: "late shutdown result" } });
  await new Promise<void>(done => setImmediate(done));
  expect(await f.repository.snapshot()).toEqual(before);
});

test("a prepared outbox without committed enqueue intent never grants task execution", async () => {
  const f = await setup(); f.enqueue.mockRejectedValueOnce(new Error("Synthetic enqueue loss")); await f.run();
  const id = Object.keys((await f.repository.snapshot()).readJobs)[0]!;
  await f.repository.mutateExecution(id, state => {
    const record = state.readJobs[id]!.taskDispatchSecret!;
    state.readJobs[id]!.taskDispatchSecret = { profile: record.profile, executionId: id, taskId: record.taskId, bindingHash: record.bindingHash,
      state: "PREPARED", attempts: 0, createdAt: record.createdAt };
  });
  const before = await f.repository.snapshot(), record = before.readJobs[id]!.taskDispatchSecret!;
  await expect(readJobQueue(f.services).executeTask({ profile: "read-task-delivery/v1", executionId: id, taskId: record.taskId }, { timeoutMs: 1000 })).rejects.toThrow("enqueue intent");
  expect(await f.repository.snapshot()).toEqual(before); expect(f.sdk.callTool).not.toHaveBeenCalled();
});

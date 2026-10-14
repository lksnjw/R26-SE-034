import { afterEach, expect, test, vi } from "vitest";
import { boundedChatFixture } from "./fixtures/bounded-chat-task.js";
import { TaskRecords } from "./fixtures/bounded-read-task.js";
import { assertChatTaskOutbox, chatTaskCommandSchema, configureChatTaskDispatch, recoverChatTaskOutboxes } from "../src/agent/chat-task-outbox.js";
import { publicChatOperation } from "../src/agent/chat-jobs.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import type { ChatOperation } from "../src/repository/store.js";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map(close => close())); vi.useRealTimers(); });
async function setup(options: Parameters<typeof boundedChatFixture>[0] = {}) { const f = await boundedChatFixture(options); closers.push(f.close); return f; }
const commandFor = (op: ChatOperation) => chatTaskCommandSchema.parse({ profile: "chat-task-delivery/v1", operationId: op.id, taskId: assertChatTaskOutbox(op).taskId });

test("bounded HTTP chat commits outbox and user message without model/ERP work; task returns only saved answer", async () => {
  const f = await setup(), response = await f.send({ model: "model-b" }); expect(response.statusCode, response.body).toBe(202);
  expect(response.json().data.taskDispatch).toBe("ENQUEUED"); expect(f.sent).toHaveLength(1);
  expect(f.fetchImplementation).not.toHaveBeenCalled(); expect(f.sdk.callTool).not.toHaveBeenCalled();
  const op = (await f.repository.snapshot()).chatOperations[f.sent[0]!.operationId]!;
  expect(op.status).toBe("QUEUED"); expect(assertChatTaskOutbox(op).state).toBe("ENQUEUED");
  expect(publicChatOperation(op)).not.toHaveProperty("taskDispatchSecret");
  const result = await f.queue.executeTask(f.sent[0]!, { timeoutMs: 2000 }); expect(result.status).toBe("ANSWERED");
  expect(f.sdk.callTool).toHaveBeenCalledOnce();
  const snapshot = await f.repository.snapshot(), finished = snapshot.chatOperations[op.id]!;
  expect(finished.inputCiphertext).toBeUndefined(); expect(finished.taskLeaseSecret).toBeUndefined();
  expect(snapshot.chats[f.sessionId]!.messages).toHaveLength(2);
  expect(f.fetchImplementation.mock.calls.every(([, init]) => JSON.parse(String(init?.body)).model === "model-b")).toBe(true);
  const events = structuredClone(snapshot.chatOperationEvents[op.id]);
  expect(await f.queue.executeTask(f.sent[0]!, { timeoutMs: 2000 })).toMatchObject({ status: "ANSWERED", id: op.id });
  const repeat = await f.send({ model: "model-b" }); expect(repeat.json().data.operation.id).toBe(op.id);
  expect(f.enqueue).toHaveBeenCalledOnce(); expect(f.sdk.callTool).toHaveBeenCalledOnce();
  expect((await f.repository.snapshot()).chatOperationEvents[op.id]).toEqual(events);
  expect(JSON.stringify(result)).not.toMatch(/private-fixture-key|taskDispatchSecret|taskLeaseSecret|inputCiphertext/);
});

test("new authoritative owner restores original task/model identity, not changed defaults", async () => {
  const storage = new TaskRecords(), f = await setup({ storage }); await f.send({ model: "model-b" }); const command = f.sent[0]!;
  await f.close(); closers.splice(closers.indexOf(f.close), 1);
  const reopened = await setup({ storage, sessionId: f.sessionId });
  expect((await reopened.queue.executeTask(command, { timeoutMs: 2000 })).status).toBe("ANSWERED");
  expect(reopened.fetchImplementation.mock.calls.every(([, init]) => JSON.parse(String(init?.body)).model === "model-b")).toBe(true);
  expect(reopened.sdk.callTool).toHaveBeenCalledOnce(); expect(f.sdk.callTool).not.toHaveBeenCalled();
});

test.each(["actor", "contract", "connection"])("changed %s fails original queued chat before a tool dispatch", async kind => {
  const f = await setup(); await f.send();
  if (kind === "actor") await f.repository.mutate(state => { state.users.owner!.status = "Inactive"; });
  else if (kind === "contract") vi.spyOn(f.services.registries, "snapshot").mockReturnValue({ ...f.services.registries.snapshot(), tools: [] });
  else f.services.config.erpbridgeRoleMap = { "Platform Admin": "changed" };
  expect((await f.queue.executeTask(f.sent[0]!, { timeoutMs: 2000 })).status).toBe("FAILED");
  expect(f.sdk.callTool).not.toHaveBeenCalled(); expect(f.fetchImplementation).not.toHaveBeenCalled();
});

test("task commands cannot carry model, actor or input authority, and outbox identity detects edits", async () => {
  const f = await setup(); await f.send(); const command = f.sent[0]!, before = await f.repository.snapshot();
  await expect(f.queue.executeTask({ ...command, actorId: "other" } as never, { timeoutMs: 2000 })).rejects.toThrow();
  await expect(f.queue.executeTask({ ...command, taskId: `chat-${"a".repeat(64)}` }, { timeoutMs: 2000 })).rejects.toThrow();
  expect(await f.repository.snapshot()).toEqual(before);
  const op = structuredClone(before.chatOperations[command.operationId]!); op.modelBinding!.model = "other";
  expect(() => assertChatTaskOutbox(op)).toThrow("identity");
  expect(() => configureChatTaskDispatch(f.repository, { timeoutMs: 100, enqueue: f.enqueue })).toThrow("new bounded owner");
});

test("a live claimed chat cannot acknowledge a duplicate delivery; expired claim reconciles without replay", async () => {
  const f = await setup(); await f.send(); const command = f.sent[0]!;
  const claimedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 5000).toISOString();
  await f.repository.mutate(state => { const op = state.chatOperations[command.operationId]!; op.status = "RUNNING"; op.workerId = "old-worker"; op.epoch++;
    op.taskLeaseSecret = { profile: "chat-task-lease/v1", workerId: op.workerId, epoch: op.epoch, claimedAt, expiresAt };
    op.attempts.push({ id: "original-attempt", toolName: "demo.echo", argumentHash: "synthetic", status: "DISPATCH_INTENT", startedAt: claimedAt }); });
  await expect(f.queue.executeTask(command, { timeoutMs: 2000 })).rejects.toThrow("still live");
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 6000);
  expect((await f.queue.executeTask(command, { timeoutMs: 2000 })).status).toBe("RECOVERY_REQUIRED");
  expect((await f.repository.snapshot()).chatOperations[command.operationId]!.attempts[0]!.status).toBe("UNKNOWN");
  expect(f.sdk.callTool).not.toHaveBeenCalled(); expect(f.fetchImplementation).not.toHaveBeenCalled();
});

test("deadline fences an ignored-cancellation SDK response and late answer; duplicate cannot replay", async () => {
  const f = await setup(); await f.send(); let finish!: (value: unknown) => void;
  f.sdk.callTool.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const command = f.sent[0]!, result = f.queue.executeTask(command, { timeoutMs: 100 });
  await vi.waitFor(() => expect(f.sdk.callTool).toHaveBeenCalledOnce());
  expect((await result).status).toBe("RECOVERY_REQUIRED");
  const before = await f.repository.snapshot(); expect(before.chatOperations[command.operationId]!.attempts[0]!.status).toBe("UNKNOWN");
  finish({ content: [], structuredContent: { value: "late response" } }); await new Promise(resolve => setTimeout(resolve, 30));
  expect((await f.repository.snapshot()).chats[f.sessionId]!.messages).toHaveLength(1);
  expect((await f.queue.executeTask(command, { timeoutMs: 2000 })).status).toBe("RECOVERY_REQUIRED"); expect(f.sdk.callTool).toHaveBeenCalledOnce();
});

test("bounded stop awaits/fences its task even when the model ignores cancellation", async () => {
  const f = await setup(); await f.send(); let release!: (response: Response) => void;
  f.fetchImplementation.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const result = f.queue.executeTask(f.sent[0]!, { timeoutMs: 2000 }); await vi.waitFor(() => expect(f.fetchImplementation).toHaveBeenCalledOnce());
  await f.queue.stop(); expect((await result).status).toBe("RECOVERY_REQUIRED");
  release(Response.json({ choices: [{ message: { content: "Late model answer" } }] })); await new Promise(resolve => setTimeout(resolve, 20));
  expect((await f.repository.snapshot()).chats[f.sessionId]!.messages).toHaveLength(1); expect(f.sdk.callTool).not.toHaveBeenCalled();
});

test("selected node task saves a proposal only, bound to the original draft", async () => {
  const f = await setup(), timestamp = new Date().toISOString();
  await f.repository.mutate(state => { state.workflows.nodeflow = { ...state.workflows.workflow!, id: "nodeflow", name: "Report", yaml: f.yaml, steps: 1, createdAt: timestamp, updatedAt: timestamp }; state.versions.nodeflow = []; });
  const context = { workflowId: "nodeflow", nodeId: "echo", baseVersion: 1, baseHash: workflowContentHash(f.yaml) };
  const response = await f.send({ content: "Improve this node label", nodeContext: context }); expect(response.statusCode, response.body).toBe(202);
  expect((await f.queue.executeTask(f.sent[0]!, { timeoutMs: 2000 })).status).toBe("ANSWERED");
  const state = await f.repository.snapshot(), proposal = (state.chats[f.sessionId]!.messages.at(-1)!.artifacts as any).proposal;
  expect(proposal).toMatchObject({ ...context, status: "PROPOSED" }); expect(state.workflows.nodeflow!.yaml).toBe(f.yaml);
  expect(f.sdk.callTool).not.toHaveBeenCalled(); expect(state.executions).toEqual({});
});

test("a workflow-generation chat task saves an editable draft without publishing or executing it", async () => {
  const f = await setup(), response = await f.send({ content: "Create a workflow to echo the fixture", model: "model-b" });
  expect(response.statusCode, response.body).toBe(202);
  expect((await f.queue.executeTask(f.sent[0]!, { timeoutMs: 2000 })).status).toBe("ANSWERED");
  const state = await f.repository.snapshot(), op = state.chatOperations[f.sent[0]!.operationId]!;
  expect(op.artifactRefs).toContainEqual(expect.objectContaining({ type: "workflow-draft" }));
  const id = op.artifactRefs!.find(value => value.type === "workflow-draft")!.id;
  expect(state.workflows[id]).toMatchObject({ draftVersion: 1, publishedVersion: 0, canRun: false });
  expect(state.executions).toEqual({}); expect(f.sdk.callTool).not.toHaveBeenCalled();
  expect(f.fetchImplementation.mock.calls.every(([, init]) => JSON.parse(String(init?.body)).model === "model-b")).toBe(true);
});

test("queued cancellation is acknowledged without model/ERP work or a fabricated assistant answer", async () => {
  const f = await setup(); await f.send(); const command = f.sent[0]!, actor = (await f.repository.effectiveUser("owner"))!;
  expect((await f.queue.cancel(command.operationId, actor)).status).toBe("CANCELLED");
  expect((await f.queue.executeTask(command, { timeoutMs: 2000 })).status).toBe("CANCELLED");
  expect((await f.repository.snapshot()).chats[f.sessionId]!.messages).toHaveLength(1);
  expect(f.fetchImplementation).not.toHaveBeenCalled(); expect(f.sdk.callTool).not.toHaveBeenCalled();
});

test.each(["PREPARED", "ENQUEUE_INTENT", "ENQUEUED"])("before/after commit faults at %s retain original identity and recover without model/ERP", async stage => {
  for (const after of [false, true]) {
    const storage = new TaskRecords(), f = await setup({ storage }); let attempted!: ChatOperation;
    storage.failWhen = state => { const op = Object.values(state.chatOperations)[0]; if (op?.taskDispatchSecret?.state === stage) { attempted = structuredClone(op); return true; } return false; };
    storage.commitBeforeFailure = after;
    const response = await f.send(); expect(response.statusCode).toBe(stage === "ENQUEUED" ? 503 : 500);
    expect(f.fetchImplementation).not.toHaveBeenCalled(); expect(f.sdk.callTool).not.toHaveBeenCalled();
    await f.close(); closers.splice(closers.indexOf(f.close), 1);
    const reopened = await setup({ storage, sessionId: f.sessionId });
    const absent = stage === "PREPARED" && !after, recovery = await recoverChatTaskOutboxes(reopened.repository);
    expect(recovery.inspected).toBe(absent || stage === "ENQUEUED" && after ? 0 : 1);
    expect(reopened.fetchImplementation).not.toHaveBeenCalled(); expect(reopened.sdk.callTool).not.toHaveBeenCalled();
    if (!absent) {
      const op = (await reopened.repository.snapshot()).chatOperations[attempted.id]!;
      expect(commandFor(op)).toEqual(commandFor(attempted)); expect(assertChatTaskOutbox(op).state).toBe("ENQUEUED");
      expect((await reopened.queue.executeTask(commandFor(op), { timeoutMs: 2000 })).status).toBe("ANSWERED");
      expect(reopened.sdk.callTool).toHaveBeenCalledOnce();
    }
  }
});

test("lost queue ACK is recoverable with the same task; no default-model reevaluation or new chat message", async () => {
  const f = await setup({ enqueue: async () => { throw new Error("Unconfirmed queue delivery"); } });
  const first = await f.send(); expect(first.statusCode).toBe(202); expect(first.json().data.taskDispatch).toBe("PENDING");
  const before = await f.repository.snapshot(), id = first.json().data.operation.id;
  expect(assertChatTaskOutbox(before.chatOperations[id]!).state).toBe("ENQUEUE_INTENT");
  f.enqueue.mockResolvedValueOnce({ taskId: commandFor(before.chatOperations[id]!).taskId, outcome: "ALREADY_EXISTS" });
  const repeat = await f.send(); expect(repeat.json().data.operation.id).toBe(id); expect(repeat.json().data.taskDispatch).toBe("ENQUEUED");
  expect((await f.repository.snapshot()).chats[f.sessionId]!.messages).toHaveLength(1);
  expect(f.fetchImplementation).not.toHaveBeenCalled(); expect(f.sdk.callTool).not.toHaveBeenCalled();
});

test("an abandoned enqueue cannot promote its late acknowledgement or execute chat work", async () => {
  let finish!: (value: { taskId: string; outcome: "CREATED" }) => void;
  const f = await setup({ timeoutMs: 20, enqueue: () => new Promise(resolve => { finish = resolve; }) });
  const response = await f.send(); expect(response.json().data.taskDispatch).toBe("PENDING");
  const op = (await f.repository.snapshot()).chatOperations[response.json().data.operation.id]!;
  finish({ taskId: commandFor(op).taskId, outcome: "CREATED" }); await new Promise(resolve => setTimeout(resolve, 20));
  expect(assertChatTaskOutbox((await f.repository.snapshot()).chatOperations[op.id]!).state).toBe("ENQUEUE_INTENT");
  expect(f.fetchImplementation).not.toHaveBeenCalled(); expect(f.sdk.callTool).not.toHaveBeenCalled();
});

test("terminal task acknowledgement requires its exact saved answer and complete event journal", async () => {
  const f = await setup(); await f.send(); const command = f.sent[0]!;
  await f.queue.executeTask(command, { timeoutMs: 2000 }); const before = await f.repository.snapshot();
  await f.repository.mutate(state => { state.chats[f.sessionId]!.messages.pop(); });
  await expect(f.queue.executeTask(command, { timeoutMs: 2000 })).rejects.toThrow("terminal receipt");
  await f.repository.mutate(state => { state.chats[f.sessionId] = structuredClone(before.chats[f.sessionId]!); state.chatOperationEvents[command.operationId]!.pop(); });
  await expect(f.queue.executeTask(command, { timeoutMs: 2000 })).rejects.toThrow("terminal receipt");
  expect(f.sdk.callTool).toHaveBeenCalledOnce();
});

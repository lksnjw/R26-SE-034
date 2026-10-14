import { expect, test, vi } from "vitest";
import { firebaseReadTaskTransport, firebaseChatTaskTransport, firebaseReadbackTaskTransport, firebaseOperationTaskTransport } from "../src/firebase/read-task-transport.js";
const command = { profile: "read-task-delivery/v1" as const, executionId: "original-run", taskId: `read-${"a".repeat(64)}` };

test("operation queue preserves generation identity without accepting effect or approval authority", async () => {
  const enqueue = vi.fn(async () => {}), transport = firebaseOperationTaskTransport({ enqueue });
  const operation = { profile: "operation-task-delivery/v1" as const, executionId: "original-run", taskId: `operation-${"d".repeat(64)}` };
  expect(await transport.enqueue(operation, new AbortController().signal)).toEqual({ taskId: operation.taskId, outcome: "CREATED" });
  expect(enqueue).toHaveBeenCalledWith(operation, { id: operation.taskId, dispatchDeadlineSeconds: 300 });
  await expect(transport.enqueue({ ...operation, approvalId: "forged" } as never, new AbortController().signal)).rejects.toThrow();
  await expect(transport.enqueue({ ...operation, arguments: {} } as never, new AbortController().signal)).rejects.toThrow();
  await expect(transport.enqueue(command as never, new AbortController().signal)).rejects.toThrow(); expect(enqueue).toHaveBeenCalledOnce();
});

test("status-query queue carries no effect arguments or authority and rejects other task profiles", async () => {
  const enqueue = vi.fn(async () => {}), transport = firebaseReadbackTaskTransport({ enqueue });
  const query = { profile: "readback-task-delivery/v1" as const, executionId: "original-run", queryId: "original-query", taskId: `readback-${"c".repeat(64)}` };
  expect(await transport.enqueue(query, new AbortController().signal)).toEqual({ taskId: query.taskId, outcome: "CREATED" });
  expect(enqueue).toHaveBeenCalledWith(query, { id: query.taskId, dispatchDeadlineSeconds: 300 });
  await expect(transport.enqueue(command as never, new AbortController().signal)).rejects.toThrow(); expect(enqueue).toHaveBeenCalledOnce();
});
test("chat queue preserves exact original operation identity and rejects read commands", async () => {
  const enqueue = vi.fn(async () => {}), transport = firebaseChatTaskTransport({ enqueue });
  const chat = { profile: "chat-task-delivery/v1" as const, operationId: "original-chat", taskId: `chat-${"b".repeat(64)}` };
  expect(await transport.enqueue(chat, new AbortController().signal)).toEqual({ taskId: chat.taskId, outcome: "CREATED" });
  expect(enqueue).toHaveBeenCalledWith(chat, { id: chat.taskId, dispatchDeadlineSeconds: 300 });
  await expect(transport.enqueue(command as never, new AbortController().signal)).rejects.toThrow(); expect(enqueue).toHaveBeenCalledOnce();
});
test("Admin queue adapter preserves the exact hashed task identity and bounded queue deadline", async () => {
  const enqueue = vi.fn(async () => {}), transport = firebaseReadTaskTransport({ enqueue });
  expect(await transport.enqueue(command, new AbortController().signal)).toEqual({ taskId: command.taskId, outcome: "CREATED" });
  expect(enqueue).toHaveBeenCalledWith(command, { id: command.taskId, dispatchDeadlineSeconds: 300 });
});
test.each(["functions/task-already-exists", "ALREADY_EXISTS", "functions/permission-denied", "functions/unknown-error"])("only the exact duplicate acknowledgement is reconcilable: %s", async code => {
  const transport = firebaseReadTaskTransport({ enqueue: vi.fn(async () => { throw { code, secret: "must not escape" }; }) });
  const outcome = transport.enqueue(command, new AbortController().signal);
  if (code === "functions/task-already-exists") expect(await outcome).toEqual({ taskId: command.taskId, outcome: "ALREADY_EXISTS" });
  else await expect(outcome).rejects.toThrow("acknowledgement is unconfirmed");
});
test("aborted or forged task requests cannot enter the SDK queue", async () => {
  const enqueue = vi.fn(async () => {}), transport = firebaseReadTaskTransport({ enqueue }), controller = new AbortController(); controller.abort();
  await expect(transport.enqueue(command, controller.signal)).rejects.toThrow();
  await expect(transport.enqueue({ ...command, actorId: "admin" } as never, new AbortController().signal)).rejects.toThrow();
  expect(enqueue).not.toHaveBeenCalled();
});
test("late ignored-cancellation queue acknowledgement cannot be reported accepted", async () => {
  let finish!: () => void; const controller = new AbortController(), enqueue = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const result = firebaseReadTaskTransport({ enqueue }).enqueue(command, controller.signal); controller.abort(); finish();
  await expect(result).rejects.toThrow("after cancellation");
});

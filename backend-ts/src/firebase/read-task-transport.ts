import { getApps, initializeApp } from "firebase-admin/app";
import { getFunctions, type TaskOptions } from "firebase-admin/functions";
import { readTaskCommandSchema, type ReadTaskCommand, type ReadTaskTransport } from "../runner/read-task-outbox.js";
import { chatTaskCommandSchema, type ChatTaskCommand, type ChatTaskTransport } from "../agent/chat-task-outbox.js";
import { readbackTaskCommandSchema, type ReadbackTaskCommand, type ReadbackTaskTransport } from "../runner/readback-task-outbox.js";
import { operationTaskCommandSchema, type OperationTaskCommand, type OperationTaskTransport } from "../runner/operation-task-outbox.js";

export type FirebaseTaskQueue<T = ReadTaskCommand> = { enqueue(data: T, options: TaskOptions): Promise<void> };

/** Adapter acknowledgement is queue acceptance only, never ERP completion.
 * Only the documented exact duplicate category reconciles a stable task ID. */
export function firebaseReadTaskTransport(queue: FirebaseTaskQueue): ReadTaskTransport {
  return firebaseTaskTransport(queue, raw => readTaskCommandSchema.parse(raw));
}
export function firebaseChatTaskTransport(queue: FirebaseTaskQueue<ChatTaskCommand>): ChatTaskTransport {
  return firebaseTaskTransport(queue, raw => chatTaskCommandSchema.parse(raw));
}
export function firebaseReadbackTaskTransport(queue: FirebaseTaskQueue<ReadbackTaskCommand>): ReadbackTaskTransport {
  return firebaseTaskTransport(queue, raw => readbackTaskCommandSchema.parse(raw));
}
export function firebaseOperationTaskTransport(queue: FirebaseTaskQueue<OperationTaskCommand>): OperationTaskTransport {
  return firebaseTaskTransport(queue, raw => operationTaskCommandSchema.parse(raw));
}
function firebaseTaskTransport<T extends { taskId: string }>(queue: FirebaseTaskQueue<T>, parse: (raw: T) => T) {
  return Object.freeze({ timeoutMs: 10_000, async enqueue(raw: T, signal: AbortSignal) {
    const command = parse(raw);
    if (signal.aborted) throw new Error("Task enqueue wait was cancelled");
    let outcome: "CREATED" | "ALREADY_EXISTS" = "CREATED";
    try { await queue.enqueue(command, { id: command.taskId, dispatchDeadlineSeconds: 300 }); }
    catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "functions/task-already-exists")
        throw new Error("Firebase task enqueue acknowledgement is unconfirmed");
      outcome = "ALREADY_EXISTS";
    }
    if (signal.aborted) throw new Error("Task enqueue acknowledgement arrived after cancellation");
    return { taskId: command.taskId, outcome };
  } });
}

/** Lazy SDK construction. Discovery/import cannot acquire credentials, open
 * application storage or enqueue work. Admin app caching is not repo caching. */
export function openFirebaseReadTaskTransport(projectId: string, region: string): ReadTaskTransport {
  return firebaseReadTaskTransport(openQueue<ReadTaskCommand>(projectId, region, "executeReadTask"));
}
export function openFirebaseChatTaskTransport(projectId: string, region: string): ChatTaskTransport {
  return firebaseChatTaskTransport(openQueue<ChatTaskCommand>(projectId, region, "executeChatTask"));
}
export function openFirebaseReadbackTaskTransport(projectId: string, region: string): ReadbackTaskTransport {
  return firebaseReadbackTaskTransport(openQueue<ReadbackTaskCommand>(projectId, region, "executeReadbackTask"));
}
export function openFirebaseOperationTaskTransport(projectId: string, region: string): OperationTaskTransport {
  return firebaseOperationTaskTransport(openQueue<OperationTaskCommand>(projectId, region, "executeOperationTask"));
}
function openQueue<T>(projectId: string, region: string, name: "executeReadTask" | "executeChatTask" | "executeReadbackTask" | "executeOperationTask") {
  if (!/^[a-z][a-z0-9-]{4,62}$/.test(projectId) || !/^[a-z]+-[a-z]+\d$/.test(region)) throw new Error("Invalid Firebase task scope");
  const appName = `lcwe-task-${projectId}`, app = getApps().find(app => app.name === appName) ?? initializeApp({ projectId }, appName);
  return getFunctions(app).taskQueue<T>(`locations/${region}/functions/${name}`);
}

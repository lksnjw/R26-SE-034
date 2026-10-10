import { expect, vi } from "vitest";
import { stringify } from "yaml";
import jwt from "jsonwebtoken";
import { readbackTaskFixture } from "./readback-task.js";
import { operationJobQueue } from "../../src/runner/operation-jobs.js";
import { configureOperationTaskDispatch, type OperationTaskTransport, type OperationTaskCommand } from "../../src/runner/operation-task-outbox.js";
import { exactBridgeName } from "../../src/tools/erpbridge-contract.js";
import type { TaskRecords } from "./bounded-read-task.js";

export async function operationTaskFixture(options: { records?: TaskRecords; enqueue?: OperationTaskTransport["enqueue"]; timeoutMs?: number; configure?: boolean; twoEffects?: boolean } = {}) {
  const s = await readbackTaskFixture(options.records ? { records: options.records } : {}), { repository, services, sdk } = s;
  const sent: OperationTaskCommand[] = [], enqueue = vi.fn<OperationTaskTransport["enqueue"]>(options.enqueue ?? (async command => {
    sent.push(structuredClone(command)); return { taskId: command.taskId, outcome: "CREATED" };
  }));
  if (options.configure !== false) configureOperationTaskDispatch(repository, { enqueue, timeoutMs: options.timeoutMs ?? 1000 });
  sdk.callTool.mockImplementation(async (name, args) => name === exactBridgeName(s.target) ? { content: [], structuredContent: {
    value: args.value, state: "ABSENT", settled: true, observedAt: new Date().toISOString() } } : { content: [], structuredContent: { accepted: true } });
  const baselineCalls = sdk.callTool.mock.calls.length;
  const request = (method: "GET" | "POST", url: string, payload?: object, userId = "requester") => s.app.inject({ method, url,
    headers: { authorization: `Bearer ${jwt.sign({}, services.config.jwtSecret, { subject: userId, expiresIn: 3600 })}` }, ...(payload ? { payload } : {}) });
  if (!(await repository.read(state => state.workflows.bounded))) {
    await repository.mutate(state => {
      const source = state.workflows.flow!, yaml = stringify({ name: "Bounded reviewed operation", description: "Read and independently approve exact effects", trigger: { type: "manual" }, steps: [
        { id: "inspect", action: s.target.name, parameters: { value: "original" } },
        { id: "send", action: s.effect.name, parameters: { value: "{{inspect.structuredContent.value}}" } },
        ...(options.twoEffects ? [{ id: "second", action: s.effect.name, parameters: { value: "next" } }] : []) ] });
      state.workflows.bounded = { ...source, id: "bounded", name: "Bounded reviewed operation", yaml, steps: options.twoEffects ? 3 : 2,
        publishedVersion: 0, draftVersion: 1, canRun: false, status: "PENDING" }; state.versions.bounded = [];
    });
    const publication = await request("POST", "/api/workflows/bounded/publish", {}); expect(publication.statusCode, publication.body).toBe(200);
  }
  const queue = operationJobQueue(services), run = (key = "bounded-operation-original-key-001") => request("POST", "/api/workflows/bounded/run", { mode: "async-operation", idempotencyKey: key, input: {} });
  const approvalCommand = async (id: string, key = "bounded-independent-decision-001") => {
    const view = await request("GET", `/api/executions/${id}?view=approval`, undefined, "reviewer"); expect(view.statusCode, view.body).toBe(200);
    const approval = view.json().data.runtimeApproval; return { approvalId: approval.id, baseVersion: approval.version, reviewHash: approval.reviewHash, decisionKey: key };
  };
  const approve = async (id: string, command?: object, actor = "reviewer") => request("POST", `/api/executions/${id}/approve`, command ?? await approvalCommand(id), actor);
  return { ...s, sent, enqueue, baselineCalls, queue, request, run, approvalCommand, approve };
}

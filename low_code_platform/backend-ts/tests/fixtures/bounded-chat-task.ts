import { vi } from "vitest";
import { boundedReadFixture, TaskRecords } from "./bounded-read-task.js";
import { ProviderRuntime } from "../../src/providers/runtime.js";
import { SynthesisService } from "../../src/synthesis/service.js";
import { chatJobQueue } from "../../src/agent/chat-jobs.js";
import { configureChatTaskDispatch, type ChatTaskCommand, type ChatTaskTransport } from "../../src/agent/chat-task-outbox.js";

export async function boundedChatFixture(options: { storage?: TaskRecords; enqueue?: ChatTaskTransport["enqueue"]; timeoutMs?: number; sessionId?: string } = {}) {
  const f = await boundedReadFixture({ storage: options.storage ?? new TaskRecords() });
  const yaml = "name: Report\ndescription: Synthetic\ntrigger:\n  type: manual\nsteps:\n  - id: echo\n    action: demo.echo\n    parameters:\n      value: fixture";
  const fetchImplementation = vi.fn<typeof fetch>(async (_url, init) => {
    const input = JSON.parse(String(init?.body)), system = input.messages[0].content;
    if (system.includes("ONE SELECTED NODE PATCH")) return Response.json({ choices: [{ message: { content: '{"description":"Proposed label"}' } }] });
    if (system.includes("WORKFLOW DRAFT SYNTHESIS")) return Response.json({ choices: [{ message: { content: yaml } }] });
    const completed = input.messages.some((message: { role: string }) => message.role === "tool");
    return Response.json({ choices: [{ finish_reason: completed ? "stop" : "tool_calls", message: completed ? { content: "Confirmed synthetic read." } : {
      content: "", tool_calls: [{ id: "read-one", type: "function", function: { name: "demo.echo", arguments: '{"value":"fixture"}' } }] } }],
      usage: { prompt_tokens: 5, completion_tokens: 7 } });
  });
  const runtime = new ProviderRuntime(f.repository, f.services.executor, fetchImplementation);
  runtime.activate({ id: "fixture", name: "Fixture", type: "openai_compatible", baseURL: "https://model.example.test/v1", apiKey: "private-fixture-key",
    model: "model-a", additionalModels: ["model-b"], temperature: 0, timeoutMs: 1000,
    egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://model.example.test", runtimeAnalysisDataClasses: [], interactiveDataClasses: ["restricted"],
      reviewedAt: "2026-10-07T00:00:00.000Z", reviewedBy: { id: "owner", name: "owner" } } });
  const services = Object.assign(f.services, { providerRuntime: runtime, synthesis: new SynthesisService(runtime, f.services.registries, f.services.validator) });
  const sent: ChatTaskCommand[] = [], enqueue = vi.fn<ChatTaskTransport["enqueue"]>(options.enqueue ?? (async command => {
    sent.push(structuredClone(command)); return { taskId: command.taskId, outcome: "CREATED" };
  }));
  configureChatTaskDispatch(f.repository, { timeoutMs: options.timeoutMs ?? 1000, enqueue });
  const created = options.sessionId ? undefined : await f.app.inject({ method: "POST", url: "/api/chat/sessions", headers: f.headers, payload: {} });
  const sessionId = options.sessionId ?? created!.json().data.id;
  const send = (extra: Record<string, unknown> = {}) => f.app.inject({ method: "POST", url: `/api/chat/sessions/${sessionId}/messages`, headers: f.headers,
    payload: { content: "Show me invoices", delivery: "async-chat", idempotencyKey: "bounded-chat-task-fixture-0001", ...extra } });
  return { ...f, services, runtime, fetchImplementation, sent, enqueue, sessionId, send, yaml, queue: chatJobQueue(services) };
}

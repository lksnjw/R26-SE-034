import { afterEach, expect, test, vi } from "vitest";
import { protectedPreparationFixture as fixture } from "./fixtures/protected-preparation.js";
import { publishProtectedOperation } from "../src/workflows/protected-operation-publication.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import { admitProtectedOperation } from "../src/runner/protected-job-admission.js";
import { runProtectedOperation } from "../src/runner/protected-job-worker.js";
import { ProtectedJobCheckpoints } from "../src/runner/protected-job-checkpoints.js";

vi.setConfig({ testTimeout: 15_000 });
const closers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const value of closers.splice(0).reverse()) await value.close(); vi.restoreAllMocks(); });
const key = "protected-analysis-original-request-key-01";
async function setup(configure?: (source: any) => void, configureProvider?: (s: Awaited<ReturnType<typeof fixture>>) => void) {
  const s = await fixture("analysis"); closers.push(s);
  if (configure) { configure(s.source); await s.saveSource(); }
  configureProvider?.(s);
  const base = await s.repository.readAuthoritative(state => ({ baseVersion: state.workflows.flow!.draftVersion, baseHash: workflowContentHash(state.workflows.flow!.yaml) }));
  await publishProtectedOperation(s.services, "flow", s.actor, base);
  s.sdk.callTool.mockImplementation((async (_name: string, args: Record<string, unknown>) => ({ content: [], structuredContent: { text: String(args.id) } })) as any);
  const inputs: unknown[] = [];
  s.modelFetch.mockImplementation((async (_url: unknown, init: RequestInit) => {
    const request = JSON.parse(String(init.body)), data = JSON.parse(request.messages[1].content); inputs.push(data);
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ text: `Analysed ${data.INPUT}` }) } }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
  }) as any);
  const admit = async (items = ["one", "two"]) => admitProtectedOperation(s.services, "flow", s.actor, { items }, key);
  return { ...s, inputs, admit };
}

test("internal analysis admission dispatches nothing, then owned items preserve distinct real model answers/usage", async () => {
  const s = await setup(), admitted = await s.admit(), id = String(admitted.execution.id);
  expect(s.sdk.callTool).not.toHaveBeenCalled(); expect(s.modelFetch).not.toHaveBeenCalled();
  const result = await runProtectedOperation(s.services, id);
  expect(result.status, JSON.stringify(result)).toBe("DONE"); expect(result.finalOutput).toEqual(["Analysed one", "Analysed two"]);
  expect(result.stepOutputs).toMatchObject({ "each/0/body_next": { structuredContent: { text: "Analysed one" } }, "each/1/body_next": { structuredContent: { text: "Analysed two" } } });
  expect(result.tokens).toEqual({ input: 22, output: 14, total: 36 }); expect(s.modelFetch).toHaveBeenCalledTimes(2); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
  expect(s.inputs).toMatchObject([{ INPUT: "one", INSTRUCTION: "Return acknowledged text" }, { INPUT: "two" }]);
  const state = await s.repository.snapshot(); expect(Object.values(state.executions[id]!.protectedInvocationSecret!.intents).filter(intent => intent.purpose === "analysis")).toHaveLength(2);
  expect(JSON.stringify(result)).not.toMatch(/private-model-key|private-synthetic-token|protectedJobSecret|admissionSeal/);
  expect((await s.admit()).execution.id).toBe(id); await runProtectedOperation(s.services, id); expect(s.modelFetch).toHaveBeenCalledTimes(2);
});

test("empty collection does not infer a model answer or invoke a provider", async () => {
  const s = await setup(), admitted = await s.admit([]), result = await runProtectedOperation(s.services, String(admitted.execution.id));
  expect(result.status).toBe("DONE"); expect(result.finalOutput).toEqual([]); expect(s.modelFetch).not.toHaveBeenCalled(); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("unmeasured analysis usage is not exposed as a measured zero-token event", async () => {
  const s = await setup(); s.modelFetch.mockImplementation((async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"text":"Valid but unmeasured"}' } }] })) as any);
  const id = String((await s.admit(["one"])).execution.id), result = await runProtectedOperation(s.services, id);
  expect(result.status).toBe("DONE"); expect(result.finalOutput).toEqual(["Valid but unmeasured"]);
  const events = (await s.repository.snapshot()).executionEvents[id]!.filter(event => event.type === "node.analysis_completed");
  expect(events).toHaveLength(1); expect(events[0]!.payload.measured).toBe(false);
  expect(events[0]!.payload).not.toHaveProperty("inputTokens"); expect(events[0]!.payload).not.toHaveProperty("outputTokens");
});

test("nested analyses retain complete tuple identity and separate answers/aggregates", async () => {
  const s = await setup(source => {
    const each = source.metadata.controlFlow.root.nodes[0], body = each.body;
    source.steps[0].parameters.id = "{{each.item}}/{{nested.item}}";
    each.body = { kind: "sequence", nodes: [{ kind: "foreach", id: "nested", maxItems: 2,
      items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "array", items: [{ kind: "literal", value: "x" }, { kind: "literal", value: "y" }] } },
      body, collect: each.collect }] };
    each.collect = { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "nodeOutput", nodeId: "nested", path: ["value"] } };
    source.metadata.controlFlow.root.nodes[1].output.schema.items = { type: "array", items: { type: "string" } };
  });
  const result = await runProtectedOperation(s.services, String((await s.admit()).execution.id));
  expect(result.status, JSON.stringify(result)).toBe("DONE");
  expect(result.finalOutput).toEqual([["Analysed one/x", "Analysed one/y"], ["Analysed two/x", "Analysed two/y"]]);
  expect(result.stepOutputs).toMatchObject({ "each/0/nested/1/body_next": { structuredContent: { text: "Analysed one/y" } },
    "each/1/nested/0/body_next": { structuredContent: { text: "Analysed two/x" } } });
  expect(result.tokens).toEqual({ input: 44, output: 28, total: 72 }); expect(s.modelFetch).toHaveBeenCalledTimes(4); expect(s.sdk.callTool).toHaveBeenCalledTimes(4);
}, 30_000); // Complete-history nested functional check, not a latency benchmark.

test.each([true, false])("selected decision branch controls analysis entry without fabricating an answer, enabled=%s", async enabled => {
  const s = await setup(source => {
    const group = source.metadata.controlFlow.root.nodes[0].body.nodes[0];
    group.body.nodes[1] = { kind: "if", id: "gate", predicate: { kind: "ref", source: "workflowInput", path: ["enabled"] },
      then: { kind: "sequence", nodes: [{ kind: "action", nodeId: "body_next" }] }, else: { kind: "sequence", nodes: [] },
      merge: { schema: { type: "string" }, then: { kind: "ref", source: "nodeOutput", nodeId: "body_next", path: ["structuredContent", "text"] },
        else: { kind: "literal", value: "Analysis not requested" } } };
    group.output.success = { kind: "ref", source: "nodeOutput", nodeId: "gate", path: ["value"] };
    source.trigger.config.inputSchema.properties.enabled = { type: "boolean" }; source.trigger.config.inputSchema.required.push("enabled");
  });
  const admitted = await admitProtectedOperation(s.services, "flow", s.actor, { items: ["one", "two"], enabled }, key);
  const result = await runProtectedOperation(s.services, String(admitted.execution.id));
  expect(result.status, JSON.stringify(result)).toBe("DONE");
  expect(result.finalOutput).toEqual(enabled ? ["Analysed one", "Analysed two"] : ["Analysis not requested", "Analysis not requested"]);
  expect(s.modelFetch).toHaveBeenCalledTimes(enabled ? 2 : 0); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
  if (!enabled) expect(result.stepOutputs).not.toHaveProperty("each/0/body_next");
});

test("a configured fallback model cannot replay a failed protected invocation", async () => {
  const s = await setup(undefined, value => value.providerRuntime.activate({ ...value.providerRuntime.configuration!, fallbackModel: "other-model" }));
  s.modelFetch.mockResolvedValue(new Response("Synthetic provider outage", { status: 503 }) as never);
  const result = await runProtectedOperation(s.services, String((await s.admit()).execution.id));
  expect(result.status).toBe("RECOVERY_REQUIRED"); expect(s.modelFetch).toHaveBeenCalledTimes(1); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
});

test.each(["invalid-json", "wrong-schema", "tool-call", "provider-error"])("%s response is not a business fault, handler or next-item permit", async kind => {
  const s = await setup();
  s.modelFetch.mockImplementation((async () => {
    if (kind === "provider-error") return new Response("Synthetic provider outage", { status: 503 });
    return Response.json({ choices: [{ finish_reason: kind === "tool-call" ? "tool_calls" : "stop", message: kind === "tool-call" ? {
      content: null, tool_calls: [{ id: "invented", type: "function", function: { name: "send_email", arguments: "{}" } }] } : { content: kind === "invalid-json" ? "not JSON" : '{"text":42}' } }] });
  }) as any);
  const id = String((await s.admit()).execution.id), result = await runProtectedOperation(s.services, id);
  expect(result.status).toBe("RECOVERY_REQUIRED"); expect(s.modelFetch).toHaveBeenCalledTimes(1); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
  expect(result.stepOutputs).not.toHaveProperty("each/0/body_next"); expect(result.stepOutputs).not.toHaveProperty("each/0/fallback");
  await runProtectedOperation(s.services, id); expect(s.modelFetch).toHaveBeenCalledTimes(1);
});

test("read business absence enters its own handler without invoking the skipped model", async () => {
  const s = await setup(); s.sdk.callTool.mockImplementation((async (_name: string, args: Record<string, unknown>) => args.id === "missing" ? {
    content: [], isError: true, _meta: { "com.erpbridge/error": { type: "not_found", retryable: false } }
  } : { content: [], structuredContent: { text: String(args.id) } }) as any);
  const result = await runProtectedOperation(s.services, String((await s.admit(["missing", "two"])).execution.id));
  expect(result.status).toBe("DONE"); expect(result.finalOutput).toEqual(["ERP_RESOURCE_NOT_FOUND", "Analysed two"]); expect(s.modelFetch).toHaveBeenCalledTimes(1);
});

test("provider revision changes after claim fence the original worker even for identical reactivation", async () => {
  const s = await setup(), id = String((await s.admit()).execution.id), cp = await ProtectedJobCheckpoints.claim(s.services, id);
  try { s.providerRuntime.activate(s.providerRuntime.configuration!); expect(cp!.controller.signal.aborted).toBe(true); await expect(cp!.initialize()).rejects.toThrow(/provider.*revision/); await cp!.stop(); }
  finally { cp!.close(); }
  expect(s.sdk.callTool).not.toHaveBeenCalled(); expect(s.modelFetch).not.toHaveBeenCalled();
});

test("declared input budget refuses model entry rather than trimming or skipping required input", async () => {
  const s = await setup(source => { source.steps[1].max_input_chars = 3; }), id = String((await s.admit(["oversized"])).execution.id);
  const result = await runProtectedOperation(s.services, id); expect(result.status).toBe("FAILED"); expect(s.sdk.callTool).toHaveBeenCalledTimes(1); expect(s.modelFetch).not.toHaveBeenCalled();
  expect(result.stepOutputs).not.toHaveProperty("each/0/body_next"); expect(result.stepOutputs).not.toHaveProperty("each/0/fallback");
});

test.each(["cancel", "actor", "provider"])("%s change during model wait fences late answers and subsequent items", async kind => {
  const s = await setup(); let entered!: () => void, release!: () => void;
  const entry = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  s.modelFetch.mockImplementation((async () => { entered(); await held; return Response.json({ choices: [{ message: { content: '{"text":"late"}' }, finish_reason: "stop" }] }); }) as any);
  const id = String((await s.admit()).execution.id), work = runProtectedOperation(s.services, id);
  try {
    await entry;
    if (kind === "provider") s.providerRuntime.activate(s.providerRuntime.configuration!);
    if (kind !== "provider") await s.repository.mutate(state => {
      if (kind === "actor") state.users.requester!.status = "disabled";
      if (kind === "cancel") state.executions[id]!.readProgress!.cancellation = { requestedAt: new Date().toISOString(), requestedBy: { id: s.actor.id, name: s.actor.name } };
    });
    const result = await work; expect(result.status).toBe("RECOVERY_REQUIRED"); expect(result.stepOutputs).not.toHaveProperty("each/0/body_next");
    expect(s.modelFetch).toHaveBeenCalledTimes(1); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
  } finally { release(); }
});

test("selected model remains invocation-scoped without changing the administration default", async () => {
  const s = await setup(source => { source.steps[1].model = "other-model"; }), id = String((await s.admit(["one"])).execution.id);
  expect((await runProtectedOperation(s.services, id)).status).toBe("DONE");
  expect(JSON.parse(String((s.modelFetch.mock.calls[0] as any)[1].body)).model).toBe("other-model"); expect(s.providerRuntime.configuration!.model).toBe("fixture-model");
});

test("clean yield after a confirmed model answer resumes without repeating read or analysis", async () => {
  const s = await setup(), id = String((await s.admit()).execution.id), cp = await ProtectedJobCheckpoints.claim(s.services, id);
  try {
    await cp!.initialize();
    for (;;) { const point = await cp!.next(); if (point!.kind === "action") await cp!.executeAction(); else await cp!.advanceControl(point!); if (s.modelFetch.mock.calls.length) break; }
    await cp!.yield();
  } finally { cp!.close(); }
  expect((await runProtectedOperation(s.services, id)).status).toBe("DONE"); expect(s.modelFetch).toHaveBeenCalledTimes(2); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
});

test.each(["unsafe", "overflow", "over-budget"])("%s measured token usage cannot be acknowledged as a valid item answer", async kind => {
  const s = await setup(source => { source.steps[1].max_output_tokens = 1024; }); s.modelFetch.mockImplementation((async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"text":"otherwise valid"}' } }],
    usage: { prompt_tokens: kind === "unsafe" ? Number.MAX_SAFE_INTEGER + 1 : kind === "overflow" ? Number.MAX_SAFE_INTEGER : 11,
      completion_tokens: kind === "over-budget" ? 1025 : 7 } })) as any);
  const result = await runProtectedOperation(s.services, String((await s.admit(["one"])).execution.id)); expect(result.status).toBe("RECOVERY_REQUIRED");
  expect(result.stepOutputs).not.toHaveProperty("each/0/body_next"); expect(result.tokens).toEqual({ input: 0, output: 0, total: 0 }); expect(s.modelFetch).toHaveBeenCalledTimes(1);
});

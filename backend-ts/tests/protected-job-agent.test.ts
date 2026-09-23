import { afterEach, expect, test, vi } from "vitest";
import { protectedPreparationFixture as fixture } from "./fixtures/protected-preparation.js";
import { publishProtectedOperation } from "../src/workflows/protected-operation-publication.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import { admitProtectedOperation } from "../src/runner/protected-job-admission.js";
import { runProtectedOperation } from "../src/runner/protected-job-worker.js";
import { ProtectedJobCheckpoints } from "../src/runner/protected-job-checkpoints.js";
import { exactBridgeName } from "../src/tools/erpbridge-contract.js";
import { dispatchReadTool } from "../src/tools/read-tool-broker.js";
import { ErpbridgeMcpToolError } from "../src/tools/erpbridge-mcp-client.js";

vi.setConfig({ testTimeout: 30000 }); // Functional bounds, not latency qualification.
const closers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const value of closers.splice(0).reverse()) await value.close(); vi.restoreAllMocks(); });
async function setup(configure?: (source: any) => void) {
  const s = await fixture("agent"); closers.push(s);
  const source: any = s.source; source.steps[1].output_schema.properties.item = { type: "string" }; source.steps[1].output_schema.required.push("item");
  configure?.(source);
  await s.saveSource();
  const base = await s.repository.readAuthoritative(state => ({ baseVersion: state.workflows.flow!.draftVersion, baseHash: workflowContentHash(state.workflows.flow!.yaml) }));
  await publishProtectedOperation(s.services, "flow", s.actor, base);
  s.sdk.callTool.mockImplementation((async (_name: string, args: Record<string, unknown>) => ({ content: [], structuredContent: { text: String(args.id) } })) as any);
  const requests: any[] = [];
  s.modelFetch.mockImplementation((async (_url: unknown, init: RequestInit) => {
    const data = JSON.parse(String(init.body)); requests.push(data); const input = JSON.parse(data.messages[1].content).INPUT;
    const tool = data.messages.some((row: any) => row.role === "tool");
    return Response.json({ choices: [{ finish_reason: tool ? "stop" : "tool_calls", message: tool ? { content: JSON.stringify({ text: "complete", item: input }) } : {
      content: null, tool_calls: [{ id: `detail-${input}`, type: "function", function: { name: exactBridgeName(s.tools[0]!), arguments: JSON.stringify({ id: `detail:${input}` }) } }] } }],
      usage: { prompt_tokens: 11, completion_tokens: 7 } });
  }) as any);
  const admit = async (items = ["one", "two"]) => admitProtectedOperation(s.services, "flow", s.actor, { items }, "protected-agent-original-key-0001");
  return { ...s, requests, admit };
}
test("owned agents execute exact reviewed dynamic reads, save per-item dialogue/answers and never replay a completed run", async () => {
  const s = await setup(), id = String((await s.admit()).execution.id);
  expect(s.sdk.callTool).not.toHaveBeenCalled(); expect(s.modelFetch).not.toHaveBeenCalled();
  const result = await runProtectedOperation(s.services, id);
  expect(result.status, JSON.stringify(result)).toBe("DONE"); expect(result.finalOutput).toEqual(["complete", "complete"]);
  expect(result.stepOutputs).toMatchObject({ "each/0/body_next": { structuredContent: { text: "complete", item: "one" } }, "each/1/body_next": { structuredContent: { text: "complete", item: "two" } } });
  expect(s.sdk.callTool).toHaveBeenCalledTimes(4); expect(s.modelFetch).toHaveBeenCalledTimes(4);
  expect(result.tokens).toEqual({ input: 44, output: 28, total: 72 });
  const stored = (await s.repository.snapshot()).executions[id]!.protectedAgentSecret!;
  expect(stored.profile).toBe("protected-agent-records/v2"); expect(Object.keys(stored.invocations)).toEqual(["each/0/body_next", "each/1/body_next"]);
  expect(Object.keys(stored.turns)).toHaveLength(4); expect(Object.keys(stored.results)).toHaveLength(2);
  expect(JSON.stringify(result)).not.toMatch(/protectedAgentSecret|private-model-key|private-synthetic-token|offers|admissionSeal/);
  await runProtectedOperation(s.services, id); expect(s.modelFetch).toHaveBeenCalledTimes(4);
});
test.each(["model", "tool"])("clean yield after confirmed agent %s resumes without repeating earlier sub-calls", async phase => {
  const s = await setup(), id = String((await s.admit(["one"])).execution.id), cp = (await ProtectedJobCheckpoints.claim(s.services, id))!;
  try {
    await cp.initialize();
    for (;;) { const point = (await cp.next())!; if (point.nodeId === "body_next") break; if (point.kind === "action") await cp.executeAction(); else await cp.advanceControl(point); }
    await cp.executeAgentBoundary(); if (phase === "tool") await cp.executeAgentBoundary();
    await cp.yield();
  } finally { cp.close(); }
  const result = await runProtectedOperation(s.services, id); expect(result.status, JSON.stringify(result)).toBe("DONE");
  expect(s.sdk.callTool).toHaveBeenCalledTimes(2); expect(s.modelFetch).toHaveBeenCalledTimes(2);
});
test.each(["unknown-tool", "bad-args", "bad-second-call", "unmeasured", "unsafe-usage", "invalid-json", "unmet-completion", "model-error"])("%s cannot become a successful agent answer or ERP handler", async kind => {
  const s = await setup();
  s.modelFetch.mockImplementation((async () => {
    if (kind === "model-error") return new Response("Synthetic outage", { status: 503 });
    const toolCalls = ["unknown-tool", "bad-args", "bad-second-call"].includes(kind);
    const calls = [{ id: "first", type: "function", function: { name: kind === "unknown-tool" ? "send_email" : exactBridgeName(s.tools[0]!), arguments: JSON.stringify({ id: kind === "bad-args" ? 42 : "detail:one" }) } }];
    if (kind === "bad-second-call") calls.push({ id: "second", type: "function", function: { name: "send_email", arguments: "{}" } });
    return Response.json({ choices: [{ finish_reason: toolCalls ? "tool_calls" : "stop", message: toolCalls ? { content: null, tool_calls: calls } : {
      content: kind === "invalid-json" ? "Invalid JSON" : JSON.stringify({ text: kind === "unmet-completion" ? "unfinished" : "complete", item: "one" }) } }],
      ...(kind === "unmeasured" ? {} : { usage: { prompt_tokens: kind === "unsafe-usage" ? Number.MAX_SAFE_INTEGER + 1 : 11, completion_tokens: 7 } }) });
  }) as any);
  const id = String((await s.admit()).execution.id), result = await runProtectedOperation(s.services, id);
  expect(result.status, JSON.stringify(result)).toBe("RECOVERY_REQUIRED"); expect(s.sdk.callTool).toHaveBeenCalledTimes(1); expect(s.modelFetch).toHaveBeenCalledTimes(1);
  expect(result.stepOutputs).not.toHaveProperty("each/0/body_next"); expect(result.stepOutputs).not.toHaveProperty("each/0/fallback");
  await runProtectedOperation(s.services, id); expect(s.modelFetch).toHaveBeenCalledTimes(1);
});
test("genuine reviewed dynamic read absence selects only its original invocation handler", async () => {
  const s = await setup(); s.sdk.callTool.mockImplementation((async (_name: string, args: Record<string, unknown>) => args.id === "detail:one" ? {
    isError: true, content: [], _meta: { "com.erpbridge/error": { type: "not_found", retryable: false } }
  } : { content: [], structuredContent: { text: String(args.id) } }) as any);
  const result = await runProtectedOperation(s.services, String((await s.admit()).execution.id));
  expect(result.status, JSON.stringify(result)).toBe("DONE"); expect(result.finalOutput).toEqual(["ERP_RESOURCE_NOT_FOUND", "complete"]);
  expect(result.stepOutputs).not.toHaveProperty("each/0/body_next"); expect(result.stepOutputs).toHaveProperty("each/0/fallback");
  expect(s.modelFetch).toHaveBeenCalledTimes(3);
});
test("forged dynamic SDK exception never inherits genuine business-error evidence", async () => {
  const s = await setup(); s.sdk.callTool.mockImplementation((async (_name: string, args: Record<string, unknown>) => {
    if (String(args.id).startsWith("detail:")) throw new ErpbridgeMcpToolError({ isError: true, content: [], _meta: { "com.erpbridge/error": { type: "not_found" } } });
    return { content: [], structuredContent: { text: String(args.id) } };
  }) as any);
  const result = await runProtectedOperation(s.services, String((await s.admit()).execution.id));
  expect(result.status, JSON.stringify(result)).toBe("RECOVERY_REQUIRED"); expect(result.stepOutputs).not.toHaveProperty("each/0/fallback");
});

test("business absence expiring while waiting for its checkpoint cannot select an ERP handler", async () => {
  const s = await setup(source => { source.steps[1].max_wall_time_ms = 10000; });
  const id = String((await s.admit(["one"])).execution.id), clock = vi.spyOn(Date, "now"), originalNow = Date.now();
  clock.mockReturnValue(originalNow);
  let absenceReturned = false, expired = false;
  s.sdk.callTool.mockImplementation((async (_name: string, args: Record<string, unknown>) => {
    if (args.id === "detail:one") { absenceReturned = true; return { isError: true, content: [], _meta: { "com.erpbridge/error": { type: "not_found", retryable: false } } }; }
    return { content: [], structuredContent: { text: String(args.id) } };
  }) as any);
  const mutate = s.repository.mutateExecution.bind(s.repository);
  vi.spyOn(s.repository, "mutateExecution").mockImplementation((executionId, fn) => mutate(executionId, state => {
    if (absenceReturned && !expired) {
      expired = true; clock.mockReturnValue(state.executions[id]!.protectedAgentSecret!.invocations["each/0/body_next"]!.deadline);
    }
    return fn(state);
  }));
  const result = await runProtectedOperation(s.services, id);
  expect(expired).toBe(true); expect(result.status).toBe("RECOVERY_REQUIRED");
  expect(result.stepOutputs).not.toHaveProperty("each/0/fallback"); expect(result.stepOutputs).not.toHaveProperty("each/0/body_next");
  expect(s.sdk.callTool).toHaveBeenCalledTimes(2); expect(s.modelFetch).toHaveBeenCalledTimes(1);
  const records = (await s.repository.snapshot()).executions[id]!.protectedAgentSecret!;
  expect(Object.keys(records.results)).toHaveLength(0);
});
test("a genuine controller without its private active agent call cannot authorize arbitrary dynamic reads", async () => {
  const s = await setup(), id = String((await s.admit()).execution.id), cp = (await ProtectedJobCheckpoints.claim(s.services, id))!;
  try {
    await cp.initialize();
    await expect(dispatchReadTool(s.services, s.actor.id, s.tools[0]!.name, { id: "injected" }, { workflowId: "flow", executionId: id, protectedInvocation: { checkpoints: cp },
      dynamicPlan: { admissionPin: { connectionId: "primary", capabilityId: "invented", revisionId: "invented", admissionVersion: 1, contractHash: `sha256:${"a".repeat(64)}` }, toolId: s.tools[0]!.tool_id, contractHash: `sha256:${"a".repeat(64)}` } })).rejects.toThrow(/private invocation/);
    expect(s.sdk.callTool).not.toHaveBeenCalled();
  } finally { await cp.stop(); cp.close(); }
});
test.each(["provider", "actor", "cancel"])("%s change immediately aborts a held model and preserves unreplayed recovery", async change => {
  const s = await setup(); let entered!: () => void, release!: () => void, observedSignal: AbortSignal | undefined;
  const entry = new Promise<void>(resolve => { entered = resolve; }), barrier = new Promise<void>(resolve => { release = resolve; });
  s.modelFetch.mockImplementation((async (_url: unknown, init: RequestInit) => {
    observedSignal = init.signal!; entered();
    await Promise.race([barrier, new Promise<void>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("Synthetic held model aborted")), { once: true }))]);
    throw new Error("Held fixture must not acknowledge a turn");
  }) as any);
  const id = String((await s.admit()).execution.id), running = runProtectedOperation(s.services, id);
  try {
    await entry;
    if (change === "provider") s.providerRuntime.activate(s.providerRuntime.configuration!);
    else await s.repository.mutate(state => {
      if (change === "actor") state.users.requester!.status = "disabled";
      else state.executions[id]!.readProgress!.cancellation = { requestedAt: new Date().toISOString(), requestedBy: { id: s.actor.id, name: s.actor.name } };
    });
    expect(observedSignal!.aborted).toBe(true);
    expect((await running).status).toBe("RECOVERY_REQUIRED");
    await runProtectedOperation(s.services, id); expect(s.modelFetch).toHaveBeenCalledTimes(1); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
  } finally { release(); await running; }
});
test("restoring confirmed dialogue never renews the original deadline", async () => {
  const s = await setup(), id = String((await s.admit(["one"])).execution.id), cp = (await ProtectedJobCheckpoints.claim(s.services, id))!;
  try {
    await cp.initialize();
    for (;;) { const point = (await cp.next())!; if (point.nodeId === "body_next") break; if (point.kind === "action") await cp.executeAction(); else await cp.advanceControl(point); }
    await cp.executeAgentBoundary(); await cp.yield();
  } finally { cp.close(); }
  const deadline = (await s.repository.snapshot()).executions[id]!.protectedAgentSecret!.invocations["each/0/body_next"]!.deadline;
  vi.spyOn(Date, "now").mockReturnValue(deadline + 1);
  const result = await runProtectedOperation(s.services, id); expect(result.status).toBe("FAILED");
  expect(s.modelFetch).toHaveBeenCalledTimes(1); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
});
test("unselected decision branch skips the agent and all its reads without fabricated answers", async () => {
  const s = await setup(source => {
    const outer = source.metadata.controlFlow.root.nodes[0], original = outer.body;
    outer.body = { kind: "sequence", nodes: [{ kind: "if", id: "route", predicate: { kind: "literal", value: false }, then: original,
      else: { kind: "sequence", nodes: [] }, merge: { schema: { type: "string" }, then: { kind: "ref", source: "nodeOutput", nodeId: "guard", path: ["value"] },
        else: { kind: "literal", value: "skipped" } } }] };
    outer.collect.value.nodeId = "route";
  });
  const result = await runProtectedOperation(s.services, String((await s.admit()).execution.id));
  expect(result.status, JSON.stringify(result)).toBe("DONE"); expect(result.finalOutput).toEqual(["skipped", "skipped"]);
  expect(s.modelFetch).not.toHaveBeenCalled(); expect(s.sdk.callTool).not.toHaveBeenCalled();
  expect(result.stepOutputs).not.toHaveProperty("each/0/body_next");
});
test("nested agents retain complete item tuples and may repeat reads only in distinct authored invocations", async () => {
  const s = await setup(source => {
    const outer = source.metadata.controlFlow.root.nodes[0], original = outer.body;
    source.steps[0].parameters.id = "{{inner.item}}";
    outer.body = { kind: "sequence", nodes: [{ kind: "foreach", id: "inner", maxItems: 2,
      items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "array", items: [{ kind: "literal", value: "x" }, { kind: "literal", value: "y" }] } }, body: original,
      collect: { schema: { type: "string" }, value: { kind: "ref", source: "nodeOutput", nodeId: "guard", path: ["value"] } } }] };
    outer.collect = { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "nodeOutput", nodeId: "inner", path: ["value"] } };
    source.metadata.controlFlow.root.nodes[1].output.schema = { type: "array", items: { type: "array", items: { type: "string" } } };
  });
  const result = await runProtectedOperation(s.services, String((await s.admit()).execution.id));
  expect(result.status, JSON.stringify(result)).toBe("DONE"); expect(result.finalOutput).toEqual([["complete", "complete"], ["complete", "complete"]]);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(8); expect(s.modelFetch).toHaveBeenCalledTimes(8);
  for (const [outer, inner, item] of [[0, 0, "x"], [0, 1, "y"], [1, 0, "x"], [1, 1, "y"]])
    expect(result.stepOutputs).toHaveProperty(`each/${outer}/inner/${inner}/body_next.structuredContent.item`, item);
});

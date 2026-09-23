import { afterEach, expect, test, vi } from "vitest";
import { protectedPreparationFixture as fixture } from "./fixtures/protected-preparation.js";
import { publishProtectedOperation } from "../src/workflows/protected-operation-publication.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import { admitProtectedOperation } from "../src/runner/protected-job-admission.js";
import { runProtectedOperation } from "../src/runner/protected-job-worker.js";
import { ProtectedJobCheckpoints } from "../src/runner/protected-job-checkpoints.js";
import { restoreProtectedJob, sealProtectedCursor } from "../src/runner/protected-job-state.js";
import { ErpbridgeMcpToolError } from "../src/tools/erpbridge-mcp-client.js";
import { dispatchReadTool } from "../src/tools/read-tool-broker.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";

// These integration scenarios restore/recheck complete receipts at every
// boundary. Allow parallel-suite CPU contention without treating Vitest's
// default five-second timeout as a latency SLO. Production/latency qualification
// is separate and remains open; no benchmark budget is changed here.
vi.setConfig({ testTimeout: 15_000 });
const closers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const value of closers.splice(0).reverse()) await value.close(); vi.restoreAllMocks(); });
const key = "protected-owned-worker-request-key-01";
async function setup(kind?: "analysis" | "agent" | "effect", configure?: (source: any) => void) {
  const s = await fixture(kind); closers.push(s);
  if (configure) { configure(s.source); await s.saveSource(); }
  const base = await s.repository.readAuthoritative(state => ({ baseVersion: state.workflows.flow!.draftVersion, baseHash: workflowContentHash(state.workflows.flow!.yaml) }));
  await publishProtectedOperation(s.services, "flow", s.actor, base);
  s.sdk.callTool.mockImplementation((async (_name: string, args: Record<string, unknown>) => ({ content: [], structuredContent: { text: String(args.id) } })) as any);
  return s;
}
type Setup = Awaited<ReturnType<typeof setup>>;
async function admit(s: Setup, items: string[] = ["one", "two"]) {
  const result = await admitProtectedOperation(s.services, "flow", s.actor, { items }, key);
  return String(result.execution.id);
}
const notFound = () => ({ isError: true, content: [], _meta: { "com.erpbridge/error": { type: "not_found", retryable: false } } });

test("owned real-broker reads keep separate item answers and original invocation keys", async () => {
  const s = await setup(), id = await admit(s), result = await runProtectedOperation(s.services, id), state = await s.repository.snapshot();
  expect(result.status, JSON.stringify(result)).toBe("DONE");
  expect(result.finalOutput).toEqual(["body_next", "body_next"]);
  expect(result.stepOutputs).toMatchObject({ "each/0/lookup": { structuredContent: { text: "one" } }, "each/1/lookup": { structuredContent: { text: "two" } } });
  expect(s.sdk.callTool).toHaveBeenCalledTimes(4);
  const ledger = state.executions[id]!.protectedInvocationSecret!;
  expect(new Set(Object.keys(ledger.intents)).size).toBe(4);
  expect(Object.values(ledger.intents).every(intent => intent.state === "ACKNOWLEDGED")).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/protectedJobSecret|protectedInvocationSecret|admissionSeal|private-synthetic-token|ciphertext/);
  expect(state.timelines[id]!.filter(row => row.nodeId === "lookup").map(row => row.invocationId)).toEqual(["each/0/lookup", "each/1/lookup"]);
});

test("empty protected collection truthfully skips with no SDK call", async () => {
  const s = await setup(), id = await admit(s, []), result = await runProtectedOperation(s.services, id);
  expect(result.status, JSON.stringify(result)).toBe("DONE"); expect(result.finalOutput).toEqual([]); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("genuine reviewed missing record selects only that item's handler", async () => {
  const s = await setup();
  s.sdk.callTool.mockImplementation((async (_name: string, args: Record<string, unknown>) => args.id === "missing" ? notFound() : { content: [], structuredContent: { text: String(args.id) } }) as any);
  const id = await admit(s, ["one", "missing", "three"]), result = await runProtectedOperation(s.services, id), state = await s.repository.snapshot();
  expect(result.status, JSON.stringify(result)).toBe("DONE");
  expect(result.finalOutput).toEqual(["body_next", "ERP_RESOURCE_NOT_FOUND", "body_next"]);
  expect(result.stepOutputs).not.toHaveProperty("each/1/body_next"); expect(result.stepOutputs).toHaveProperty("each/1/fallback");
  expect(s.sdk.callTool).toHaveBeenCalledTimes(6);
  const failures = Object.values(state.executions[id]!.protectedInvocationSecret!.receipts).filter(row => row.result.kind === "business-read-failure");
  expect(failures).toHaveLength(1); expect(failures[0]!.boundary.invocationId).toBe("each/1/lookup");
});

test.each(["timeout", "forged-error", "bad-schema", "unreviewed-error"])("%s cannot become a handler or next item", async failure => {
  const s = await setup();
  s.sdk.callTool.mockImplementation((async () => {
    if (failure === "timeout") throw new Error("Synthetic timeout");
    if (failure === "forged-error") throw new ErpbridgeMcpToolError(notFound());
    if (failure === "bad-schema") return { content: [], structuredContent: { text: 42 } };
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { type: "forbidden" } }) }] };
  }) as any);
  const id = await admit(s), result = await runProtectedOperation(s.services, id);
  expect(result.status).toBe("RECOVERY_REQUIRED"); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
  expect(result.stepOutputs).toEqual({});
  expect((await runProtectedOperation(s.services, id)).status).toBe("RECOVERY_REQUIRED"); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
});

test("original request replay returns same run without dispatch; changed input conflicts", async () => {
  const s = await setup(), id = await admit(s); await runProtectedOperation(s.services, id);
  const replay = await admitProtectedOperation(s.services, "flow", s.actor, { items: ["one", "two"] }, key);
  expect(replay.replayed).toBe(true); expect(replay.execution.id).toBe(id);
  expect((await runProtectedOperation(s.services, id)).status).toBe("DONE"); expect(s.sdk.callTool).toHaveBeenCalledTimes(4);
  await expect(admitProtectedOperation(s.services, "flow", s.actor, { items: ["different"] }, key)).rejects.toThrow(/different inputs/);
});

test.each(["analysis", "agent", "effect"] as const)("unintegrated %s driver rejects whole admission before a read prefix", async kind => {
  const s = await setup(kind); await expect(admit(s)).rejects.toThrow(/drivers/);
  expect((await s.repository.snapshot()).executions).toEqual({}); expect(s.sdk.callTool).not.toHaveBeenCalled(); expect(s.modelFetch).not.toHaveBeenCalled();
});

test("revoked request identity is denied before discovery", async () => {
  const s = await setup(); s.sdk.listTools.mockClear(); await s.repository.mutate(state => { state.users.requester!.status = "disabled"; });
  await expect(admit(s)).rejects.toThrow(/actor/); expect(s.sdk.listTools).not.toHaveBeenCalled(); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("owned controller cannot be forged by a serialized broker flag", async () => {
  const s = await setup(); await expect(dispatchReadTool(s.services, s.actor.id, s.tools[0]!.name, { id: "one" },
    { executionId: "fake", protectedInvocation: { checkpoints: { repository: s.repository, executionId: "fake", services: s.services } as any }, plan: {} as any })).rejects.toThrow(/owned checkpoint/);
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("clean boundary yield resumes without repeating completed item reads", async () => {
  const s = await setup(), id = await admit(s), cp = await ProtectedJobCheckpoints.claim(s.services, id); expect(cp).toBeDefined();
  try {
    await cp!.initialize();
    for (;;) {
      const point = await cp!.next(); expect(point).toBeDefined();
      if (point!.kind === "action") await cp!.executeRead(); else await cp!.advanceControl(point!);
      if (s.sdk.callTool.mock.calls.length === 2) break;
    }
    await cp!.yield();
  } finally { cp!.close(); }
  const result = await runProtectedOperation(s.services, id); expect(result.status, JSON.stringify(result)).toBe("DONE"); expect(s.sdk.callTool).toHaveBeenCalledTimes(4);
});

test("expired entered invocation becomes recovery-required, never replayed", async () => {
  const s = await setup(), id = await admit(s), cp = await ProtectedJobCheckpoints.claim(s.services, id);
  try {
    await cp!.initialize();
    for (;;) { const point = await cp!.next(); if (point!.kind === "action") break; await cp!.advanceControl(point!); }
    await s.repository.mutateExecution(id, state => {
      const saved = restoreProtectedJob(state, s.services, id), point = saved.machine.peek()!;
      const intent = saved.ledger.prepare(saved.machine, "read", { kind: "node" }, point.arguments, saved.run.readProgress!.epoch);
      saved.ledger.dispatchIntent(saved.machine, intent, point.arguments, saved.run.readProgress!.epoch);
      saved.run.protectedInvocationSecret = saved.ledger.snapshot(); saved.run.protectedJobSecret!.lease!.expiresAt = Date.now() - 1;
      sealProtectedCursor(s.services, state, saved.run, saved.machine);
    });
  } finally { cp!.close(); }
  expect((await runProtectedOperation(s.services, id)).status).toBe("RECOVERY_REQUIRED"); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("two workers cannot own the same live claim", async () => {
  const s = await setup(), id = await admit(s), cp = await ProtectedJobCheckpoints.claim(s.services, id);
  try { await expect(ProtectedJobCheckpoints.claim(s.services, id)).rejects.toThrow(/current worker/); }
  finally { await cp!.stop(); cp!.close(); }
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("expired never-entered preparation transfers epoch without changing its logical key", async () => {
  const s = await setup(), id = await admit(s), cp = await ProtectedJobCheckpoints.claim(s.services, id); let originalKey = "";
  try {
    await cp!.initialize();
    for (;;) { const point = await cp!.next(); if (point!.kind === "action") break; await cp!.advanceControl(point!); }
    await s.repository.mutateExecution(id, state => {
      const saved = restoreProtectedJob(state, s.services, id), point = saved.machine.peek()!;
      originalKey = saved.ledger.prepare(saved.machine, "read", { kind: "node" }, point.arguments, saved.run.readProgress!.epoch);
      saved.run.protectedInvocationSecret = saved.ledger.snapshot(); saved.run.protectedJobSecret!.lease!.expiresAt = Date.now() - 1;
      sealProtectedCursor(s.services, state, saved.run, saved.machine);
    });
  } finally { cp!.close(); }
  const result = await runProtectedOperation(s.services, id); expect(result.status).toBe("DONE"); expect(s.sdk.callTool).toHaveBeenCalledTimes(4);
  expect((await s.repository.snapshot()).executions[id]!.protectedInvocationSecret!.intents[originalKey]).toMatchObject({ state: "ACKNOWLEDGED", epoch: 3 });
});

test.each(["role", "department", "permissions", "disabled", "governance"])("queued %s revocation records a truthful terminal refusal instead of freezing", async kind => {
  const s = await setup(), id = await admit(s);
  await s.repository.mutate(state => {
    if (kind === "disabled") state.users.requester!.status = "disabled";
    if (kind === "role") state.roles[s.actor.roleId]!.name = "Changed role";
    if (kind === "department") state.users.requester!.departmentId = "different";
    if (kind === "permissions") state.users.requester!.permissionOverrides.push("new:permission");
    if (kind === "governance") state.governancePolicy = { ...state.governancePolicy, changed: true } as any;
  });
  const result = await runProtectedOperation(s.services, id); expect(result.status).toBe("FAILED"); expect(result.agentSummary).toContain("no longer permits");
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test.each(["disabled", "cancelled"])("%s during SDK wait fences late answers and prevents dependent calls", async kind => {
  const s = await setup(); let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
  s.sdk.callTool.mockImplementation((async () => { enter(); await pending; return { content: [], structuredContent: { text: "late" } }; }) as any);
  const id = await admit(s), work = runProtectedOperation(s.services, id);
  try {
    await entered;
    await s.repository.mutate(state => {
      if (kind === "disabled") state.users.requester!.status = "disabled";
      else state.executions[id]!.readProgress!.cancellation = { requestedAt: new Date().toISOString(), requestedBy: { id: s.actor.id, name: s.actor.name } };
    });
    const result = await work; expect(result.status).toBe("RECOVERY_REQUIRED"); expect(result.stepOutputs).toEqual({}); expect(s.sdk.callTool).toHaveBeenCalledTimes(1);
  } finally { release(); }
});

test.each(["actor", "validator", "source"])("%s change during discovery cannot commit a run", async kind => {
  const s = await setup(); let once = false;
  s.setDiscoveryHook(async () => {
    if (once) return; once = true;
    if (kind === "validator") s.services.validator = new RegistryValidator(s.registries, s.repository);
    else await s.repository.mutate(state => { if (kind === "actor") state.users.requester!.status = "disabled"; else state.workflows.flow!.draftVersion++; });
  });
  s.toolsChanged(); // Force fresh SDK discovery, not the already reviewed cache.
  await expect(admit(s)).rejects.toThrow(); expect((await s.repository.snapshot()).executions).toEqual({}); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test.each(["input", "admission", "receipt", "cursor"])("%s substitution cannot grant a worker claim", async kind => {
  const s = await setup(), id = await admit(s);
  await s.repository.mutate(state => {
    if (kind === "input") state.executions[id]!.workflowSnapshot!.input = { items: ["forged"] };
    if (kind === "admission") state.executions[id]!.protectedJobSecret!.requestFingerprint = `sha256:${"f".repeat(64)}`;
    if (kind === "receipt") state.executions[id]!.workflowSnapshot!.protectedCompilation!.bindingHash = `sha256:${"f".repeat(64)}`;
    if (kind === "cursor") state.protectedContinuations[id]!.ciphertext = "Zm9yZ2Vk";
  });
  await expect(ProtectedJobCheckpoints.claim(s.services, id)).rejects.toThrow(); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("nested collections retain complete tuple identity and separate aggregates", async () => {
  const s = await setup(undefined, source => {
    const each = source.metadata.controlFlow.root.nodes[0], body = each.body;
    source.steps[0].parameters.id = "{{each.item}}/{{nested.item}}";
    source.steps[1].parameters.id = "{{lookup.structuredContent.text}}";
    each.body = { kind: "sequence", nodes: [{ kind: "foreach", id: "nested", maxItems: 2,
      items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "array", items: [{ kind: "literal", value: "x" }, { kind: "literal", value: "y" }] } },
      body, collect: each.collect }] };
    each.collect = { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "nodeOutput", nodeId: "nested", path: ["value"] } };
    source.metadata.controlFlow.root.nodes[1].output.schema.items = { type: "array", items: { type: "string" } };
  });
  const id = await admit(s), result = await runProtectedOperation(s.services, id);
  expect(result.status, JSON.stringify(result)).toBe("DONE"); expect(result.finalOutput).toEqual([["one/x", "one/y"], ["two/x", "two/y"]]);
  expect(s.sdk.callTool).toHaveBeenCalledTimes(8);
  expect(Object.keys(result.stepOutputs as object)).toContain("each/1/nested/0/lookup");
  expect(result.valueOutputs).toMatchObject({ "each/0/nested": { value: ["one/x", "one/y"] }, "each/1/nested": { value: ["two/x", "two/y"] } });
}, 15_000);

test.each([true, false])("per-item decision selects one real branch and commits its typed merge, enabled=%s", async enabled => {
  const s = await setup(undefined, source => {
    const group = source.metadata.controlFlow.root.nodes[0].body.nodes[0];
    group.body = { kind: "sequence", nodes: [{ kind: "if", id: "gate", predicate: { kind: "ref", source: "workflowInput", path: ["enabled"] },
      then: { kind: "sequence", nodes: [{ kind: "action", nodeId: "lookup" }] }, else: { kind: "sequence", nodes: [{ kind: "action", nodeId: "body_next" }] },
      merge: { schema: { type: "string" }, then: { kind: "ref", source: "nodeOutput", nodeId: "lookup", path: ["structuredContent", "text"] },
        else: { kind: "ref", source: "nodeOutput", nodeId: "body_next", path: ["structuredContent", "text"] } } }] };
    group.output.success = { kind: "ref", source: "nodeOutput", nodeId: "gate", path: ["value"] };
    source.trigger.config.inputSchema.properties.enabled = { type: "boolean" }; source.trigger.config.inputSchema.required.push("enabled");
  });
  const admitted = await admitProtectedOperation(s.services, "flow", s.actor, { items: ["one", "two"], enabled }, key), id = String(admitted.execution.id);
  const result = await runProtectedOperation(s.services, id); expect(result.status, JSON.stringify(result)).toBe("DONE");
  expect(result.finalOutput).toEqual(enabled ? ["one", "two"] : ["body_next", "body_next"]); expect(s.sdk.callTool).toHaveBeenCalledTimes(2);
  expect(Object.keys(result.stepOutputs as object)).toEqual(enabled ? ["each/0/lookup", "each/1/lookup"] : ["each/0/body_next", "each/1/body_next"]);
});

test("a failed item handler propagates only to the authored outer handler and never fabricates a complete collection", async () => {
  const s = await setup(undefined, source => {
    const each = source.metadata.controlFlow.root.nodes[0], ref = (nodeId: string, ...path: string[]) => ({ kind: "ref", source: "nodeOutput", nodeId, path });
    source.steps.push({ id: "outer_fallback", action: source.steps[0].action, parameters: { id: "{{outer.error.failedNodeId}}" } });
    source.metadata.controlFlow.root.nodes = [{ kind: "protect", id: "outer", onError: { code: "ERP_RESOURCE_NOT_FOUND" }, body: { kind: "sequence", nodes: [each] },
      handler: { kind: "sequence", nodes: [{ kind: "action", nodeId: "outer_fallback" }] }, output: { schema: { type: "array", items: { type: "string" } },
        success: ref("each", "value"), handled: { kind: "array", items: [ref("outer_fallback", "structuredContent", "text")] } } },
      { kind: "return", id: "answer", output: { schema: { type: "array", items: { type: "string" } }, value: ref("outer", "value") } }];
  });
  s.sdk.callTool.mockImplementation((async (_name: string, args: Record<string, unknown>) => ["missing", "ERP_RESOURCE_NOT_FOUND"].includes(String(args.id)) ? notFound() : { content: [], structuredContent: { text: String(args.id) } }) as any);
  const id = await admit(s, ["missing", "never-entered"]), result = await runProtectedOperation(s.services, id);
  expect(result.status, JSON.stringify(result)).toBe("DONE"); expect(result.finalOutput).toEqual(["fallback"]); expect(s.sdk.callTool).toHaveBeenCalledTimes(3);
  expect(result.valueOutputs).not.toHaveProperty("each"); expect(result.stepOutputs).not.toHaveProperty("each/1/lookup");
}, 15_000);

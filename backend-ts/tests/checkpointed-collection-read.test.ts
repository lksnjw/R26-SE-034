import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { loadConfig } from "../src/config/config.js";
import { Repository, type Execution, type PersistenceBackend, type RepositoryState } from "../src/repository/store.js";
import type { HandlerServices } from "../src/http/handlers/common.js";
import { RegistryService } from "../src/registry/service.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { ruleSchema, toolSchema } from "../src/registry/schemas.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { bridgeTransportSchema, exactBridgeName } from "../src/tools/erpbridge-contract.js";
import { admissionAuthorizer, observeCapabilities, reviewCapability, captureReadAdmissionPin, capabilityContractHash } from "../src/registry/capability-admission.js";
import { compileReadWorkflow, readCompilationReceipt } from "../src/workflows/compiled-read.js";
import { newReadIterationLedger, ReadIterationCheckpoints } from "../src/runner/read-iteration-checkpoints.js";
import { newReadProgress } from "../src/runner/read-checkpoints.js";
import { completeCheckpointedCollectionRead } from "../src/runner/checkpointed-collection-read.js";
import { dispatchReadTool, type ReadDispatchContext } from "../src/tools/read-tool-broker.js";

afterEach(() => vi.useRealTimers());
const role = "Platform Admin", key = "server-held-collection-driver-key-at-least-32-bytes";
const array = { type: "array", items: { type: "string" } }, seq = (...nodes: any[]) => ({ kind: "sequence", nodes });
const action = (nodeId: string) => ({ kind: "action", nodeId }), ref = (nodeId: string, ...path: string[]) => ({ kind: "ref", source: "nodeOutput", nodeId, path });
function source(summary = false): any {
  return { name: "Collection", description: "Read each requested invoice, retain exact item answers", trigger: { type: "manual" },
    steps: [{ id: "lookup", action: "finance.read", parameters: { id: "{{each.item}}" } }, ...(summary ? [{ id: "summary", action: "invoice-read", parameters: { id: "summary" } }] : [])],
    metadata: { controlFlow: { schemaVersion: "read-control-flow/v3", root: seq({ kind: "foreach", id: "each", maxItems: 3,
      items: { schema: array, value: { kind: "ref", source: "workflowInput", path: ["rows"] } }, body: seq(action("lookup")),
      collect: { schema: { type: "string" }, value: ref("lookup", "structuredContent", "id") } }, ...(summary ? [action("summary")] : []),
      { kind: "return", id: "answer", output: { schema: array, value: ref("each", "value") } }) } } };
}
// Fault-injection test double only, not evidence of production encryption or
// a normalized store. The actual storage qualification is a separate gate.
class Persistence implements PersistenceBackend {
  readonly readQueueDurability = "encrypted-single-writer" as const;
  payload: Uint8Array | null = null; committedLoss = false;
  failWhen: ((state: RepositoryState) => boolean) | undefined;
  async load() { return this.payload; }
  async save(bytes: Uint8Array) {
    const fail = this.failWhen?.(JSON.parse(Buffer.from(bytes).toString("utf8")));
    if (fail) { this.failWhen = undefined; if (this.committedLoss) this.payload = Buffer.from(bytes); throw new Error("Lost storage acknowledgement"); }
    this.payload = Buffer.from(bytes);
  }
  async probe() {} async close() {}
}
async function setup(src = source(), input: Record<string, unknown> = { rows: ["a", "b"], private_token: "private-input-not-persisted" }, persistence: Persistence | null = null) {
  const tools = ["finance.read", "invoice-read"].map((name, index) => toolSchema.parse({ tool_id: `READ-${index}`, name, mcp_tool_name: name, is_read_only: true,
    allowed_roles: [role], risk_level: "low", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    bridge_contract: { profile: "toolplane-v1", resource_version: "1.2.3", resource_digest: (index ? "b" : "a").repeat(64), remote_roles: ["platform_admin"],
      output_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } } }));
  let registrySuffix = "";
  const registries = { snapshot: () => ({ tools, rules: [], versions: { tools: "v1", rules: "v1" } }), hash: () => capabilityContractHash(tools[0]!) + registrySuffix,
    findTool: (name: string) => tools.find(tool => [tool.name, tool.mcp_tool_name].includes(name)), findRule: () => undefined, enabledRules: () => [] } as unknown as RegistryService;
  const repository = await Repository.open(persistence), now = new Date().toISOString();
  await repository.mutate(state => { state.users.actor = { id: "actor", name: "Actor", email: "actor@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "A", departmentId: null, lastLoginAt: null, createdAt: now }; });
  const validator = new RegistryValidator(registries, repository);
  const callTool = vi.fn(async (_name: string, args: Record<string, unknown>): Promise<unknown> => ({ content: [], structuredContent: { id: String(args.id).toUpperCase() } }));
  const listTools = vi.fn(async () => tools.map(tool => ({ name: exactBridgeName(tool), inputSchema: bridgeTransportSchema(tool), outputSchema: tool.bridge_contract!.output_schema!,
    _meta: { "toolplane.resourceVersion": "1.2.3", "toolplane.resourceDigest": tool.bridge_contract!.resource_digest, "io.erpbridge/allowedRoles": ["platform_admin"] } })));
  const authorize = vi.fn(admissionAuthorizer(repository, registries));
  const erpbridgeSession = await createErpbridgeMcpSession({ baseURL: "https://fixture.example.test", token: "fixture-only", timeoutMs: 50, validator, admissionAuthorizer: authorize,
    sdkClient: { metadataComplete: true, connect: async () => {}, close: async () => {}, callTool, listTools } });
  const user = (await repository.effectiveUser("actor"))!;
  const observations = (await observeCapabilities({ repository, registries, session: erpbridgeSession, user })).observations;
  for (const observation of observations) await reviewCapability({ repository, registries, session: erpbridgeSession, user, capabilityId: observation.capabilityId,
    body: { observationId: observation.id, contractHash: observation.contractHash, decisionKey: `driver-review-${observation.toolId}-0001`, effectClass: "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Reviewed offline driver fixture" } });
  const yaml = stringify(src), pins = await repository.readAuthoritative(state => new Map(tools.map(tool => [tool.tool_id, captureReadAdmissionPin(state, registries, tool, erpbridgeSession.admissionBinding!)])));
  const plan = compileReadWorkflow(yaml, tools, role, pins), receipt = readCompilationReceipt(plan, registries.hash(), "PUBLICATION", "reviewed");
  const initial: Execution = { id: "run", workflowId: "flow", workflowName: "Collection", status: "RUNNING", startedAt: now, completedAt: null, durationMs: 0, costUsd: 0, tokens: { input: 0, output: 0, total: 0 }, startedBy: { id: "actor", name: "Actor" }, traceId: "trace-driver",
    workflowSnapshot: { version: 1, contentHash: plan.sourceHash, registryHash: registries.hash(), yaml, input: {}, executionProfile: "collection-read-v1", compilation: receipt },
    readProgress: newReadProgress(repository), iterationProgress: newReadIterationLedger("run", plan, input, role, key) };
  // Production publication/admission routes intentionally cannot create this
  // profile yet. Seed an explicit controller fixture to qualify the driver.
  await repository.mutate(state => { state.workflows.flow = { id: "flow", owner: { id: "actor", name: "Actor" }, assignedUserIds: [], archived: false } as any;
    state.versions.flow = [{ version: 1, artifactState: "PUBLISHED", yaml, compiledRead: { plan, receipt, verifiedRole: role, compiledAt: now } }]; state.executions.run = initial; });
  const token = (await validator.validateAndIssueToken("CollectionControllerFixture", yaml, role)).token!; expect(token).not.toBeNull();
  const services: HandlerServices = { config: { ...loadConfig({ APP_ENV: "test", JWT_SECRET: "collection-driver-test-secret-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "mock" }), erpbridgeRoleMap: { [role]: "platform_admin" } },
    repository, registries, validator, executor: new Executor(new ToolRegistry(), validator), erpbridgeSession };
  listTools.mockClear(); authorize.mockClear();
  return { services, repository, plan, initial, input, token, callTool, listTools, authorize, tools, drift: () => { registrySuffix = "-changed"; },
    run: (signal?: AbortSignal, assertBinding?: () => void) => completeCheckpointedCollectionRead(services, initial, input, token, plan, key, signal, assertBinding),
    get: async () => (await repository.snapshot()).executions.run! };
}

test("the governed shared driver confirms exact item answers, collection aggregate and explicit final return without a model", async () => {
  const persist = new Persistence(), s = await setup(source(), undefined, persist), result = await s.run();
  expect(result).toMatchObject({ status: "DONE", finalOutput: ["A", "B"], stepOutputs: { "each/0/lookup": { structuredContent: { id: "A" } }, "each/1/lookup": { structuredContent: { id: "B" } } }, valueOutputs: { each: { value: ["A", "B"] } } });
  expect(s.callTool.mock.calls.map(call => call[1])).toEqual([{ id: "a", role: "platform_admin" }, { id: "b", role: "platform_admin" }]); expect(s.listTools).toHaveBeenCalledOnce();
  expect(s.input.rows).toEqual(["a", "b"]); expect(JSON.stringify(await s.repository.snapshot())).not.toContain("private-input-not-persisted"); expect(JSON.stringify(await s.repository.snapshot())).not.toContain(key);
  expect((await Repository.open(persist).then(repo => repo.snapshot())).executions.run).toEqual(result);
  expect((await s.repository.snapshot()).executionEvents.run!.map(event => event.sequence)).toEqual((await s.repository.snapshot()).executionEvents.run!.map((_event, index) => index + 1));
});

test("the actual SDK call observes its already committed exact dispatch intent", async () => {
  const s = await setup(); s.callTool.mockImplementation(async (_name, args) => {
    const run = await s.get(), address = args.id === "a" ? "each/0/lookup" : "each/1/lookup";
    expect(run.readProgress!.attempts[address]).toMatchObject({ status: "DISPATCH_INTENT", invocationId: address });
    expect(run.iterationProgress!.receipts[`action:${address}`]!.status).toBe("DISPATCH_INTENT"); return { content: [], structuredContent: { id: args.id } };
  }); expect((await s.run()).status).toBe("DONE");
});

test("nested collections call every exact address once and retain nested arrays", async () => {
  const src = source(), loop = src.metadata.controlFlow.root.nodes[0]; loop.items.schema = { type: "array", items: array };
  loop.body = seq({ kind: "foreach", id: "inner", maxItems: 3, items: { schema: array, value: ref("each", "item") }, body: seq(action("lookup")), collect: loop.collect });
  loop.collect = { schema: array, value: ref("inner", "value") }; src.steps[0].parameters.id = "{{inner.item}}"; src.metadata.controlFlow.root.nodes[1].output.schema = { type: "array", items: array };
  const s = await setup(src, { rows: [["a", "b"], ["c"]] }), result = await s.run(); expect(result.finalOutput).toEqual([["A", "B"], ["C"]]);
  expect(Object.keys(result.stepOutputs!)).toEqual(["each/0/inner/0/lookup", "each/0/inner/1/lookup", "each/1/inner/0/lookup"]); expect(s.callTool).toHaveBeenCalledTimes(3);
});

test.each(["complete", "empty", "all-skipped"])("%s collection satisfies subsequent process order only from actual confirmed actions", async scenario => {
  const src = source(true), loop = src.metadata.controlFlow.root.nodes[0];
  if (scenario === "all-skipped") { loop.body = seq({ kind: "if", id: "gate", predicate: { kind: "literal", value: false }, then: structuredClone(loop.body), else: seq() }); loop.collect.value = { kind: "literal", value: "skipped" }; }
  const s = await setup(src, { rows: scenario === "empty" ? [] : ["a", "b"] });
  const rule = ruleSchema.parse({ rule_id: "ACTUAL-ORDER", rule_type: "process_order", enabled: true, enforcement_action: "block", condition: { value: ["finance.read", "invoice-read"] } });
  vi.spyOn(s.services.registries, "enabledRules").mockReturnValue([rule]); const projections: any[] = [], original = s.services.validator.validatePlan.bind(s.services.validator);
  vi.spyOn(s.services.validator, "validatePlan").mockImplementation((id, yaml, role) => { if (id === "ReadConfirmedIterations") projections.push(yaml); return original(id, yaml, role); });
  const result = await s.run(); expect(result.status).toBe(scenario === "complete" ? "DONE" : "FAILED"); expect(s.callTool).toHaveBeenCalledTimes(scenario === "complete" ? 3 : 0);
  if (scenario === "complete") { expect(result.finalOutput).toEqual(["A", "B"]); expect(projections.at(-1)).toContain("each/0/lookup"); expect(projections.at(-1)).toContain("each/1/lookup"); }
  else { expect(result.readProgress!.attempts.summary!.status).toBe("FAILED"); expect(result.stepOutputs).toBeUndefined(); }
});

test("a successful prerequisite from item one cannot authorize the skipped prerequisite in item two", async () => {
  const src = source(true), loop = src.metadata.controlFlow.root.nodes[0]; src.metadata.controlFlow.root.nodes.splice(1, 1);
  loop.items.schema = { type: "array", items: { type: "object", properties: { id: { type: "string" }, enabled: { type: "boolean" } }, required: ["id", "enabled"], additionalProperties: false } };
  loop.body = seq({ kind: "if", id: "gate", predicate: ref("each", "item", "enabled"), then: seq(action("lookup")), else: seq() }, action("summary")); loop.collect.value = ref("summary", "structuredContent", "id");
  src.steps[0].parameters.id = src.steps[1].parameters.id = "{{each.item.id}}";
  const s = await setup(src, { rows: [{ id: "a", enabled: true }, { id: "b", enabled: false }] });
  vi.spyOn(s.services.registries, "enabledRules").mockReturnValue([ruleSchema.parse({ rule_id: "ACTUAL-ORDER", rule_type: "process_order", enabled: true, enforcement_action: "block", condition: { value: ["finance.read", "invoice-read"] } })]);
  const result = await s.run(); expect(result.status).toBe("FAILED"); expect(s.callTool.mock.calls.map(call => call[1].id)).toEqual(["a", "a"]);
  expect(result.readProgress!.attempts["each/1/summary"]!.status).toBe("FAILED"); expect(result.valueOutputs?.each).toBeUndefined(); expect(result.stepOutputs?.["each/1/summary"]).toBeUndefined();
});

test.each(["publication", "review", "registry", "session", "generation", "role-map", "role", "actor", "archive", "epoch", "output"])("changed %s after the first confirmed answer denies all following SDK calls", async change => {
  const s = await setup(), original = s.repository.mutate.bind(s.repository); let changed = false;
  vi.spyOn(s.repository, "mutate").mockImplementation(async mutation => {
    const result = await original(mutation);
    const run = await s.get();
    if (!changed && run.readProgress!.attempts["each/0/lookup"]?.status === "DONE") {
      changed = true;
      if (change === "registry") s.drift();
      else if (change === "session") s.services.erpbridgeSession = undefined;
      else if (change === "generation") s.services.erpbridgeSession = { ...s.services.erpbridgeSession!, discoveryGeneration: 1 };
      else if (change === "role-map") s.services.config.erpbridgeRoleMap[role] = "changed";
      else await original(state => {
        if (change === "publication") state.versions.flow = [];
        if (change === "review") Object.values(state.capabilityAdmissions).forEach(value => { value.state = "DISABLED"; });
        if (change === "role") state.users.actor!.roleId = "role_client";
        if (change === "actor") state.users.actor!.status = "Disabled";
        if (change === "archive") state.workflows.flow!.archived = true;
        if (change === "epoch") state.executions.run!.readProgress!.epoch++;
        if (change === "output") state.executions.run!.stepOutputs!["each/0/lookup"] = { content: [], structuredContent: { id: "forged" } };
      });
    }
    return result;
  });
  await expect(s.run()).rejects.toThrow(); expect(s.callTool).toHaveBeenCalledOnce(); expect((await s.get()).status).not.toBe("DONE");
});

test.each(["cancel", "actor", "review", "publication", "registry", "role-map"])("final awaited admission changing %s blocks before SDK entry", async change => {
  const s = await setup(), original = s.authorize.getMockImplementation()!; let armed = false;
  const evaluate = s.services.validator.evaluateResolvedStep.bind(s.services.validator);
  vi.spyOn(s.services.validator, "evaluateResolvedStep").mockImplementation(async (...args) => { const value = await evaluate(...args); armed = true; return value; });
  s.authorize.mockImplementation(async (...args) => {
    await original(...args); if (!armed) return; armed = false;
    if (change === "registry") s.drift(); else if (change === "role-map") s.services.config.erpbridgeRoleMap[role] = "changed";
    else await s.repository.mutate(state => {
      if (change === "cancel") state.executions.run!.readProgress!.cancellation = { requestedAt: new Date().toISOString(), requestedBy: { id: "actor", name: "Actor" } };
      if (change === "actor") state.users.actor!.status = "Disabled";
      if (change === "review") Object.values(state.capabilityAdmissions).forEach(value => { value.state = "DISABLED"; });
      if (change === "publication") state.versions.flow = [];
    });
  });
  try { await s.run(); } catch { /* stale authoritative evidence may require recovery */ }
  expect(s.callTool).not.toHaveBeenCalled(); expect((await s.get()).status).not.toBe("DONE"); expect((await s.get()).readProgress!.attempts["each/0/lookup"]?.dispatchIntentAt).toBeUndefined();
});

test("confirmed in-flight result survives cancellation; no item/aggregate is fabricated afterward", async () => {
  const s = await setup(); s.callTool.mockImplementation(async () => {
    await s.repository.mutate(state => { state.executions.run!.readProgress!.cancellation = { requestedAt: new Date().toISOString(), requestedBy: { id: "actor", name: "Actor" } }; });
    return { content: [], structuredContent: { id: "confirmed" } };
  }); const result = await s.run(); expect(result.status).toBe("CANCELLED"); expect(result.stepOutputs?.["each/0/lookup"]).toMatchObject({ structuredContent: { id: "confirmed" } });
  expect(result.valueOutputs?.each).toBeUndefined(); expect(s.callTool).toHaveBeenCalledOnce();
});

test.each(["error", "transport", "invalid-output"])("%s stops without replay or fake aggregate success", async kind => {
  const s = await setup(); s.callTool.mockImplementation(async () => {
    if (kind === "transport") throw new Error("remote credential must not be reflected");
    return kind === "error" ? { content: [{ type: "text", text: "Denied" }], isError: true } : { content: [], structuredContent: { id: 123 } };
  }); const result = await s.run(); expect(result.status).toBe(kind === "error" ? "FAILED" : "RECOVERY_REQUIRED"); expect(s.callTool).toHaveBeenCalledOnce();
  expect(result.stepOutputs).toBeUndefined(); expect(result.valueOutputs?.each).toBeUndefined(); expect(JSON.stringify(result)).not.toContain("remote credential");
  if (kind === "error") expect((await s.repository.snapshot()).timelines.run!.find(value => value.nodeId === "lookup")!.output).toMatchObject({ isError: true });
});

test.each(["intent", "completion"])("lost %s acknowledgement never starts another item", async phase => {
  for (const committedLoss of [false, true]) {
    const persist = new Persistence(), s = await setup(source(), undefined, persist); persist.committedLoss = committedLoss;
    persist.failWhen = state => state.executions.run?.readProgress?.attempts["each/0/lookup"]?.status === (phase === "intent" ? "DISPATCH_INTENT" : "DONE");
    await expect(s.run()).rejects.toThrow(); expect(s.callTool).toHaveBeenCalledTimes(phase === "intent" ? 0 : 1); expect((await s.get()).status).toBe("RECOVERY_REQUIRED");
    expect((await s.get()).valueOutputs?.each).toBeUndefined(); await expect(s.run()).rejects.toThrow(); expect(s.callTool).toHaveBeenCalledTimes(phase === "intent" ? 0 : 1);
  }
});

test("a hung SDK call hits its configured deadline, fences the session, and never applies its late answer", async () => {
  const s = await setup(); vi.useFakeTimers(); let complete!: (value: unknown) => void;
  s.callTool.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const result = s.run(); await vi.waitFor(() => expect(s.callTool).toHaveBeenCalledOnce()); await vi.advanceTimersByTimeAsync(50);
  expect((await result).status).toBe("RECOVERY_REQUIRED"); expect(s.services.erpbridgeSession!.available).toBe(false);
  complete({ content: [], structuredContent: { id: "late" } }); await Promise.resolve(); await Promise.resolve(); expect((await s.get()).stepOutputs).toBeUndefined();
});

test("empty collections still require reviewed publication binding before claiming completion", async () => {
  const s = await setup(source(), { rows: [] }); await s.repository.mutate(state => { state.versions.flow = []; });
  await expect(s.run()).rejects.toThrow(); expect(s.callTool).not.toHaveBeenCalled(); expect((await s.get()).status).not.toBe("DONE");
});

test.each(["arguments", "source-index", "tool", "pin", "plan", "yaml", "epoch", "other-run", "other-repository", "actor", "visit", "flat-hook", "fake-journal", "no-sdk-boundary"])("a changed %s cannot borrow a genuine current journal for dispatch", async damage => {
  const s = await setup(), yaml = s.initial.workflowSnapshot!.yaml;
  const journal = new ReadIterationCheckpoints(s.repository, "run", s.initial.readProgress!.epoch, yaml, s.plan, s.input, s.tools, key);
  await journal.advance(); const point = (await journal.advance())!, node = s.plan.ir.root.nodes[0]!;
  const context: ReadDispatchContext = { workflowId: "flow", executionId: "run", plan: { yaml, stepIndex: 0, token: s.token, toolId: node.capability.toolId, contractHash: node.capability.contractHash, admissionPin: structuredClone(node.capability.admission!) },
    iteration: { checkpoints: journal, plan: structuredClone(s.plan), visit: structuredClone(point.visit) } };
  let args = point.arguments!, actorId = "actor";
  if (damage === "arguments") args = { id: "different" };
  if (damage === "source-index") context.plan!.stepIndex = 1;
  if (damage === "tool") context.plan!.toolId = "READ-1";
  if (damage === "pin") context.plan!.admissionPin!.admissionVersion++;
  if (damage === "plan") context.iteration!.plan.ir.root.nodes[0]!.inputs = { kind: "literal", value: "changed" };
  if (damage === "yaml") context.plan!.yaml += "\n# changed source";
  if (damage === "epoch") await s.repository.mutate(state => { state.executions.run!.readProgress!.epoch++; });
  if (damage === "other-run") context.executionId = "other-run";
  if (damage === "other-repository") context.iteration!.checkpoints = new ReadIterationCheckpoints(new Repository(), "run", journal.epoch, yaml, s.plan, s.input, s.tools, key);
  if (damage === "actor") { actorId = "other"; await s.repository.mutate(state => { state.users.other = { ...state.users.actor!, id: "other" }; }); }
  if (damage === "visit") context.iteration!.visit = { invocationId: "each/1/lookup", iterations: [{ loopId: "each", index: 1 }] };
  if (damage === "flat-hook") context.beforeDispatch = async () => {};
  if (damage === "fake-journal") context.iteration!.checkpoints = { repository: s.repository, executionId: "run", epoch: journal.epoch, yaml, selectedEvidence: journal.selectedEvidence.bind(journal), dispatchIntent: journal.dispatchIntent.bind(journal) } as any;
  if (damage === "no-sdk-boundary") s.services.erpbridgeSession = { ...s.services.erpbridgeSession!, dispatchBoundary: undefined } as any;
  await expect(dispatchReadTool(s.services, actorId, node.capability.action, args, context)).rejects.toThrow();
  expect(s.callTool).not.toHaveBeenCalled(); expect((await s.get()).readProgress!.attempts[point.visit.invocationId]!.status).toBe("PREPARING");
});

test.each([false, 0, null])("skipped collection bodies preserve an explicit %j collected value without tool calls", async value => {
  const src = source(), loop = src.metadata.controlFlow.root.nodes[0], schema = { type: value === null ? "null" : typeof value };
  loop.body = seq({ kind: "if", id: "gate", predicate: { kind: "literal", value: false }, then: seq(action("lookup")), else: seq() });
  loop.collect = { schema, value: { kind: "literal", value } }; src.metadata.controlFlow.root.nodes[1].output.schema = { type: "array", items: schema };
  const s = await setup(src), result = await s.run(); expect(result.status).toBe("DONE"); expect(result.finalOutput).toEqual([value, value]); expect(s.callTool).not.toHaveBeenCalled(); expect(s.listTools).not.toHaveBeenCalled();
});

test("an empty collection completes as an explicit empty array with no discovery or SDK call", async () => {
  const s = await setup(source(), { rows: [] }), result = await s.run(); expect(result.status).toBe("DONE"); expect(result.finalOutput).toEqual([]); expect(s.callTool).not.toHaveBeenCalled(); expect(s.listTools).not.toHaveBeenCalled();
});

test("the controller's worker/connection guard is rechecked after capability evaluation", async () => {
  const s = await setup(), original = s.services.validator.evaluateResolvedStep.bind(s.services.validator); let expired = false;
  vi.spyOn(s.services.validator, "evaluateResolvedStep").mockImplementation(async (...args) => { const value = await original(...args); expired = true; return value; });
  expect((await s.run(undefined, () => { if (expired) throw new Error("Controller ownership expired"); })).status).toBe("FAILED"); expect(s.callTool).not.toHaveBeenCalled();
});

test("cancellation during a hung SDK wait produces UNKNOWN rather than claiming a remote rollback", async () => {
  const s = await setup(), controller = new AbortController(); s.callTool.mockImplementation(() => new Promise(() => {}));
  const promise = s.run(controller.signal); await vi.waitFor(() => expect(s.callTool).toHaveBeenCalledOnce()); controller.abort();
  expect((await promise).status).toBe("RECOVERY_REQUIRED"); expect((await s.get()).readProgress!.attempts["each/0/lookup"]!.status).toBe("UNKNOWN"); expect(s.callTool).toHaveBeenCalledOnce();
});

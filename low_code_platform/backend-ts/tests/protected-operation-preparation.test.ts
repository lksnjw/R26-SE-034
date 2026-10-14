import { afterEach, expect, test, vi } from "vitest";
import { prepareProtectedOperationCompilation as prepare, assertProtectedOperationPreparationCurrent as assertCurrent } from "../src/workflows/protected-operation-preparation.js";
import { protectedPreparationFixture as fixture } from "./fixtures/protected-preparation.js";
import type { RepositoryState } from "../src/repository/store.js";
import { exactBridgeName } from "../src/tools/erpbridge-contract.js";
import { captureProtectedOperationPlan } from "../src/workflows/protected-operation-bindings.js";
import { parseWorkflowYAMLStrict } from "../src/parser/workflow.js";
import * as preparation from "../src/workflows/protected-operation-preparation.js";
import { McpConnectionManager } from "../src/tools/mcp-connection-runtime.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { loadConfig } from "../src/config/config.js";
import { observeCapabilities, reviewCapability } from "../src/registry/capability-admission.js";

const closers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const value of closers.splice(0).reverse()) await value.close(); vi.restoreAllMocks(); });
async function setup(kind?: "analysis" | "agent" | "effect", readback = false) { const s = await fixture(kind, readback); closers.push(s); return s; }
type Setup = Awaited<ReturnType<typeof setup>>;
const state = (s: Setup) => s.repository.snapshot();
const noCalls = (s: Setup) => { expect(s.sdk.callTool).not.toHaveBeenCalled(); expect(s.modelFetch).not.toHaveBeenCalled(); };

test.each([undefined, "analysis", "agent"] as const)("server preparation retains original %s definitions without execution or publication", async kind => {
  const s = await setup(kind), before = await state(s), prepared = await prepare(s.services, "flow", s.actor);
  expect(prepared).toMatchObject({ profile: "protected-operation-preparation/v1", workflowId: "flow", baseVersion: 1, runtimeQualified: false, originalNodes: 3, modelNodes: kind ? 1 : 0 });
  expect(Object.isFrozen(prepared)).toBe(true);
  const plan = assertCurrent(prepared, s.services, await state(s), s.actor);
  expect(plan.ir.schemaVersion).toBe("workflow-operation-ir/v9");
  expect(plan.ir.root.nodes[1]!.kind).toBe(kind ?? "action");
  expect(JSON.stringify(prepared)).not.toMatch(/private-model-key|private-synthetic-token|admissionBinding|apiKey|allowedCapabilities|inputSchema/);
  expect(await state(s)).toEqual(before); noCalls(s);
});

test("normal authenticated readiness exposes truthful compilation but cannot publish or execute protected collections", async () => {
  const s = await setup(), response = await s.request("GET", "/api/workflows/flow/readiness");
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toMatchObject({ can_attempt_run: false, published: false, compilation: { state: "NOT_PUBLISHED" }, operation_job_admission: "unavailable",
    executionProfile: "protected-draft-runtime-pending", protectedCompilation: { state: "COMPILED_RUNTIME_PENDING", summary: { runtimeQualified: false } } });
  expect(response.json().data.issues.some((issue: string) => issue.includes("durable operation iteration"))).toBe(true);
  const pub = await s.request("POST", "/api/workflows/flow/publish", {});
  expect(pub.statusCode, pub.body).toBe(422); expect(pub.body).toContain("PROTECTED_COLLECTION_RUNTIME_PENDING");
  expect((await state(s)).versions.flow).toEqual([]); expect((await state(s)).executions).toEqual({}); noCalls(s);
});

test("missing review produces blocked readable readiness without leaking SDK internals", async () => {
  const s = await setup(); await s.repository.mutate(value => { value.capabilityAdmissions = {}; });
  const response = await s.request("GET", "/api/workflows/flow/readiness");
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toMatchObject({ can_attempt_run: false, protectedCompilation: { state: "BLOCKED" } });
  expect(response.body).not.toMatch(/private-synthetic-token|private-model-key|synthetic.example.test/); noCalls(s);
});

const mutations: Array<[string, (value: RepositoryState) => void]> = [
  ["draft source", value => { value.workflows.flow!.yaml += "\n# changed source\n"; }],
  ["draft revision", value => { value.workflows.flow!.draftVersion++; }],
  ["archive", value => { value.workflows.flow!.archived = true; }],
  ["owner", value => { value.workflows.flow!.owner.id = "another-owner"; }],
  ["assignment", value => { value.workflows.flow!.assignedUserIds = ["another-user"]; }],
  ["suspended actor", value => { value.users.requester!.status = "Suspended"; }],
  ["actor record identity", value => { value.users.requester!.id = "another-actor"; }],
  ["role record identity", value => { value.roles.role_admin!.id = "another-role"; }],
  ["actor role ID", value => { value.roles.alias = { ...value.roles.role_admin!, id: "alias" }; value.users.requester!.roleId = "alias"; }],
  ["role name", value => { value.roles.role_admin!.name = "Changed role"; }],
  ["permission loss", value => { value.roles.role_admin!.permissions = []; }],
  ["permission grant", value => { value.users.requester!.permissionOverrides.push("new:permission"); }],
  ["revoked review", value => { const admission = Object.values(value.capabilityAdmissions)[0]!; admission.state = "DISABLED"; }],
  ["admission revision", value => { const admission = Object.values(value.capabilityAdmissions)[0]!; admission.version = Number(admission.version) + 1; }],
  ["review classification", value => { const revision = Object.values(value.capabilityRevisions)[0]!; (revision.policy as Record<string, unknown>).dataClass = "restricted"; }],
];
test.each(mutations)("fresh use refuses changed %s", async (_name, mutate) => {
  const s = await setup(), prepared = await prepare(s.services, "flow", s.actor);
  await s.repository.mutate(mutate);
  const current = await state(s); expect(() => assertCurrent(prepared, s.services, current, s.actor)).toThrow(); noCalls(s);
});

test.each(["role mapping", "generation", "connection session", "registry", "primary selector"])("fresh use refuses changed %s", async change => {
  const s = await setup(), prepared = await prepare(s.services, "flow", s.actor);
  if (change === "role mapping") s.config.erpbridgeRoleMap["Platform Admin"] = "not-admin";
  if (change === "generation") s.toolsChanged();
  if (change === "connection session") s.services.erpbridgeSession = { ...s.session };
  if (change === "registry") s.tools[0]!.description = "Changed original contract";
  if (change === "primary selector") s.config.erpbridgePrimaryConnectionId = "other";
  const current = await state(s); expect(() => assertCurrent(prepared, s.services, current, s.actor)).toThrow(); noCalls(s);
});

test.each(["source", "permissions", "generation", "mapping", "provider"])("preparation refuses %s change while discovery awaits", async change => {
  const s = await setup("analysis");
  s.setDiscoveryHook(async () => {
    if (change === "source") await s.repository.mutate(value => { value.workflows.flow!.yaml += "\n# changed\n"; });
    if (change === "permissions") await s.repository.mutate(value => { value.roles.role_admin!.permissions = []; });
    if (change === "generation") s.toolsChanged();
    if (change === "mapping") s.config.erpbridgeRoleMap["Platform Admin"] = "other";
    if (change === "provider") s.providerRuntime.activate(s.providerRuntime.configuration!);
  });
  await expect(prepare(s.services, "flow", s.actor)).rejects.toThrow(); noCalls(s);
});

test.each(["revision", "model removed", "analysis egress", "provider identity"])("fresh model preparation refuses changed %s", async change => {
  const s = await setup("analysis"), prepared = await prepare(s.services, "flow", s.actor), config = s.providerRuntime.configuration!;
  if (change === "model removed") { config.model = "other-model"; config.additionalModels = []; }
  if (change === "analysis egress") config.egressPolicy!.runtimeAnalysisDataClasses = [];
  if (change === "provider identity") config.id = "another-provider";
  s.providerRuntime.activate(config);
  const current = await state(s); expect(() => assertCurrent(prepared, s.services, current, s.actor)).toThrow(); noCalls(s);
});

test("agent egress is independently required rather than inherited from analysis", async () => {
  const s = await setup("agent"), config = s.providerRuntime.configuration!; config.egressPolicy!.runtimeAgentDataClasses = []; s.providerRuntime.activate(config);
  await expect(prepare(s.services, "flow", s.actor)).rejects.toThrow(/separately reviewed agent/); noCalls(s);
});

test("forged/deserialized/cross-lifecycle/cross-services preparations cannot become authority", async () => {
  const s = await setup(), prepared = await prepare(s.services, "flow", s.actor), current = await state(s);
  expect(() => assertCurrent(structuredClone(prepared), s.services, current, s.actor)).toThrow(/not owned/);
  expect(() => assertCurrent(prepared, { ...s.services }, current, s.actor)).toThrow(/not owned/);
  expect(() => assertCurrent(prepared, s.services, current, s.actor, "publication")).toThrow(/not owned/);
  const plan = assertCurrent(prepared, s.services, current, s.actor); plan.ir.root.nodes[0]!.id = "forged";
  expect(assertCurrent(prepared, s.services, current, s.actor).ir.root.nodes[0]!.id).toBe("lookup"); noCalls(s);
});

test("publication-purpose preparation requires current editing permission but still grants no publication", async () => {
  const s = await setup(), prepared = await prepare(s.services, "flow", s.actor, "publication");
  const current = await state(s); expect(assertCurrent(prepared, s.services, current, s.actor, "publication").ir.root.nodes).toHaveLength(3);
  await s.repository.mutate(value => { value.roles.role_admin!.permissions = ["workflow:read"]; });
  const reader = (await s.repository.effectiveUser("requester"))!;
  await expect(prepare(s.services, "flow", reader, "publication")).rejects.toThrow();
  expect((await prepare(s.services, "flow", reader)).runtimeQualified).toBe(false); noCalls(s);
});

test("an authored model outside the configured catalog is blocked without inference", async () => {
  const s = await setup("analysis"); s.source.steps[1].model = "not-configured"; await s.saveSource();
  await expect(prepare(s.services, "flow", s.actor)).rejects.toThrow(/current configured model/); noCalls(s);
});

test.each(["default", "additional"])("configured %s model resolution does not replace the runtime default or call inference", async selection => {
  const s = await setup("analysis");
  if (selection === "default") delete s.source.steps[1].model; else s.source.steps[1].model = "other-model";
  await s.saveSource(); const before = s.providerRuntime.binding, prepared = await prepare(s.services, "flow", s.actor);
  const plan = assertCurrent(prepared, s.services, await state(s), s.actor), model = plan.ir.root.nodes[1];
  expect(model?.kind).toBe("analysis");
  if (model?.kind === "analysis") expect(model.model).toBe(selection === "default" ? "" : "other-model");
  expect(s.providerRuntime.binding).toEqual(before); noCalls(s);
});

test("an unsupported SDK-only session cannot mint protected preparation", async () => {
  const s = await setup(); s.services.erpbridgeSession = { ...s.session, requiresReviewedRevision: false };
  await expect(prepare(s.services, "flow", s.actor)).rejects.toThrow(/reviewed SDK-entry/); noCalls(s);
});

test.each([false, true])("protected effects capture independent policy and exact read-back=%s without requesting approval", async readback => {
  const s = await setup("effect", readback), before = await state(s);
  captureProtectedOperationPlan(before, s.services, parseWorkflowYAMLStrict(before.workflows.flow!.yaml), before.workflows.flow!.yaml, s.actor.role);
  const prepared = await prepare(s.services, "flow", s.actor);
  const plan = assertCurrent(prepared, s.services, await state(s), s.actor), node = plan.ir.root.nodes.find(value => value.id === "send");
  expect(node).toMatchObject({ kind: "action", effectClass: "notification" });
  if (readback) expect(node).toMatchObject({ readback: { toolId: "protected-readback", admission: { connectionId: "erpbridge-default" } } });
  expect(prepared.capabilities).toBe(readback ? 3 : 2); expect(await state(s)).toEqual(before); noCalls(s);
});

test.each(["disabled", "revision", "missing", "reviewer authority"])("fresh effect preparation refuses changed approval %s", async change => {
  const s = await setup("effect"), prepared = await prepare(s.services, "flow", s.actor);
  await s.repository.mutate(value => {
    const policy = (value.settings.rbac as { runtimeApprovalPolicy?: Record<string, unknown> }).runtimeApprovalPolicy!;
    if (change === "disabled") policy.enabled = false;
    if (change === "revision") policy.revision = Number(policy.revision) + 1;
    if (change === "missing") delete (value.settings.rbac as Record<string, unknown>).runtimeApprovalPolicy;
    if (change === "reviewer authority") value.roles.review!.permissions = [];
  });
  const current = await state(s); expect(() => assertCurrent(prepared, s.services, current, s.actor)).toThrow(); noCalls(s);
});

test("exact required read-back cannot be replaced by other discovered tools", async () => {
  const s = await setup("effect", true), original = s.sdk.listTools.getMockImplementation()!;
  const name = exactBridgeName(s.tools.find(tool => tool.tool_id === "protected-readback")!);
  s.sdk.listTools.mockImplementation(async () => (await original()).filter(tool => tool.name !== name));
  await expect(prepare(s.services, "flow", s.actor)).rejects.toThrow(/exact current reviewed/); noCalls(s);
});

test("read-back review revocation invalidates an already prepared collection", async () => {
  const s = await setup("effect", true), prepared = await prepare(s.services, "flow", s.actor), plan = assertCurrent(prepared, s.services, await state(s), s.actor);
  const node = plan.ir.root.nodes.find(value => value.id === "send"); if (node?.kind !== "action" || !node.readback) throw new Error("Expected read-back");
  await s.repository.mutate(value => { value.capabilityAdmissions[node.readback!.admission.capabilityId]!.state = "DISABLED"; });
  const current = await state(s); expect(() => assertCurrent(prepared, s.services, current, s.actor)).toThrow(); noCalls(s);
});

test("no-model/read-only preparation neither requires nor acquires a provider or approval policy", async () => {
  const s = await setup(); expect(s.providerRuntime.configured).toBe(false);
  delete s.services.providerRuntime;
  const prepared = await prepare(s.services, "flow", s.actor);
  const current = await state(s); expect(assertCurrent(prepared, s.services, current, s.actor).ir.root.nodes).toHaveLength(3); noCalls(s);
});

test.each(["mapping", "generation", "session", "provider", "policy"])("HTTP final readiness refuses %s drift after server preparation", async change => {
  const s = await setup(change === "policy" ? "effect" : "analysis"), original = preparation.prepareProtectedOperationCompilation;
  vi.spyOn(preparation, "prepareProtectedOperationCompilation").mockImplementation(async (...args) => {
    const value = await original(...args);
    if (change === "mapping") s.config.erpbridgeRoleMap["Platform Admin"] = "other";
    if (change === "generation") s.toolsChanged();
    if (change === "session") s.services.erpbridgeSession = { ...s.session };
    if (change === "provider") s.providerRuntime.activate(s.providerRuntime.configuration!);
    if (change === "policy") await s.repository.mutate(state => { (state.settings.rbac as { runtimeApprovalPolicy: { enabled: boolean } }).runtimeApprovalPolicy.enabled = false; });
    return value;
  });
  const response = await s.request("GET", "/api/workflows/flow/readiness");
  expect(response.statusCode, response.body).toBe(change === "policy" ? 503 : 409);
  expect(response.body).not.toContain("COMPILED_RUNTIME_PENDING"); noCalls(s);
});

test.each([false, true])("real connection manager preserves default/explicit same-tool pins and secondary read-back=%s", async effect => {
  const s = await setup(effect ? "effect" : undefined, effect);
  const config = loadConfig({ APP_ENV: "test", JWT_SECRET: s.config.jwtSecret, STORAGE_DRIVER: "memory", MCP_MODE: "remote", MCP_TRANSPORT: "erpbridge-mcp",
    ERPBRIDGE_PRIMARY_CONNECTION_ID: "finance", ERPBRIDGE_CONNECTIONS_JSON: JSON.stringify([
      { id: "finance", baseURL: "https://finance.example.test", tokenEnv: "FINANCE_TOKEN", roleMap: { "Platform Admin": "admin" } },
      { id: "hr", baseURL: "https://hr.example.test", tokenEnv: "HR_TOKEN", roleMap: { "Platform Admin": "admin" } }]),
    FINANCE_TOKEN: "private-finance", HR_TOKEN: "private-hr", MCP_TIMEOUT_MS: "1000" });
  const manager = await McpConnectionManager.open({ repository: s.repository, registries: s.registries, validator: s.services.validator, config,
    factory: options => createErpbridgeMcpSession({ ...options, sdkClient: { ...s.sdk } }) });
  closers.push({ close: () => manager.stop() }); s.services.config = config; s.services.mcpConnectionRuntime = manager;
  for (const connectionId of ["finance", "hr"]) {
    await manager.command("connect", s.actor, { baseRevision: 1, requestId: `${connectionId}-connect-preparation-0001` }, undefined, connectionId);
    const session = manager.sessionFor(connectionId);
    const observations = (await observeCapabilities({ repository: s.repository, registries: s.registries, session, user: s.actor, connectionId })).observations;
    for (const observation of observations) await reviewCapability({ repository: s.repository, registries: s.registries, session, user: s.actor, connectionId,
      capabilityId: observation.capabilityId, body: { observationId: observation.id, contractHash: observation.contractHash, decisionKey: `${connectionId}-${observation.toolId}-review`,
        effectClass: observation.toolId === "protected-effect" ? "notification" : "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Synthetic selected-connection review",
        ...(observation.toolId === "protected-effect" ? { requireIndependentApproval: true } : {}) } });
  }
  s.source.steps.find((step: { id: string }) => step.id === "body_next").connection_id = "hr";
  if (effect) s.source.steps.find((step: { id: string }) => step.id === "send").connection_id = "hr";
  await s.saveSource();
  const prepared = await prepare(s.services, "flow", s.actor), plan = assertCurrent(prepared, s.services, await state(s), s.actor);
  const lookup = plan.ir.root.nodes.find(node => node.id === "lookup"), secondary = plan.ir.root.nodes.find(node => node.id === "body_next");
  expect(lookup).toMatchObject({ capability: { admission: { connectionId: "finance" } } });
  expect(secondary).toMatchObject({ capability: { admission: { connectionId: "hr" } } });
  if (effect) expect(plan.ir.root.nodes.find(node => node.id === "send")).toMatchObject({ readback: { admission: { connectionId: "hr" } } });
  if (secondary?.kind !== "action") throw new Error("Expected secondary action");
  await s.repository.mutate(value => { value.capabilityAdmissions[secondary.capability.admission!.capabilityId]!.state = "DISABLED"; });
  const current = await state(s); expect(() => assertCurrent(prepared, s.services, current, s.actor)).toThrow();
  if (lookup?.kind !== "action") throw new Error("Expected primary action");
  expect(current.capabilityAdmissions[lookup.capability.admission!.capabilityId]!.state).toBe("AVAILABLE"); noCalls(s);
});

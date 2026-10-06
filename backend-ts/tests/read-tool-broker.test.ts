import { expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { Repository } from "../src/repository/store.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { RegistryService } from "../src/registry/service.js";
import { toolSchema } from "../src/registry/schemas.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { Executor } from "../src/runner/executor.js";
import { createErpbridgeMcpSession, ErpbridgeMcpToolError } from "../src/tools/erpbridge-mcp-client.js";
import { acknowledgedReadToolFailure, observedReadPolicyFailure, dispatchReadTool } from "../src/tools/read-tool-broker.js";
import * as optionalPolicy from "../src/governance/optional-policy.js";
import { bridgeTransportSchema, exactBridgeName } from "../src/tools/erpbridge-contract.js";
import type { ToolDefinition } from "../src/registry/schemas.js";
import { stringify } from "yaml";
import { newReadProgress } from "../src/runner/read-checkpoints.js";
import { admissionAuthorizer, observeCapabilities, reviewCapability, capabilityContractHash } from "../src/registry/capability-admission.js";

async function setup(options: { write?: boolean; schema?: Record<string, unknown>; roles?: string[]; result?: unknown; contract?: ToolDefinition["bridge_contract"]; readErrorContract?: ToolDefinition["read_error_contract"]; metadataComplete?: boolean; drift?: boolean; remoteFailure?: boolean } = {}) {
  const tool = toolSchema.parse({ tool_id: "READ-1", name: "finance.read", mcp_tool_name: "finance.read", allowed_roles: options.roles ?? ["Workflow Builder"],
    is_read_only: !options.write, risk_level: "low", ...(options.contract ? { bridge_contract: options.contract } : {}),
    ...(options.readErrorContract ? { read_error_contract: options.readErrorContract } : {}), input_schema: options.schema ?? { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } });
  const registries = { snapshot: () => ({ tools: [tool], rules: [], versions: { tools: "v1", rules: "v1" } }), hash: () => capabilityContractHash(tool),
    findTool: (name: string) => name === tool.name ? tool : undefined, findRule: () => undefined, enabledRules: () => [] } as unknown as RegistryService;
  const repository = new Repository(null);
  await repository.mutate((state) => { state.users.builder = { id: "builder", name: "Builder", email: "builder@example.test", roleId: "role_builder", permissionOverrides: [],
    status: "Active", initials: "B", departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() }; });
  await repository.mutate(state => { state.users.admin = { ...state.users.builder!, id: "admin", roleId: "role_admin" }; });
  const validator = new RegistryValidator(registries, repository);
  const callTool = vi.fn(async () => options.remoteFailure ? { content: [{ type: "text", text: "Revision withdrawn" }], isError: true } : options.result ?? { content: [], structuredContent: { id: "invoice-1" } });
  const listTools = vi.fn(async () => [{ name: exactBridgeName(tool), inputSchema: bridgeTransportSchema(tool),
    ...(options.contract ? { ...(options.contract.output_schema ? { outputSchema: options.contract.output_schema } : {}), _meta: { "toolplane.resourceVersion": options.contract.resource_version, "toolplane.resourceDigest": (options.drift ? "b".repeat(64) : options.contract.resource_digest), "io.erpbridge/allowedRoles": options.contract.remote_roles } } : {}) }]);
  const authorize = vi.fn(admissionAuthorizer(repository, registries));
  const erpbridgeSession = await createErpbridgeMcpSession({ baseURL: "https://bridge.example.test", token: "test-token", timeoutMs: 1000, validator,
    ...(options.metadataComplete ? { admissionAuthorizer: authorize } : {}),
    sdkClient: { connect: async () => {}, close: async () => {}, ...(options.metadataComplete !== undefined ? { metadataComplete: options.metadataComplete } : {}), listTools, callTool } });
  if (options.metadataComplete && options.contract && !options.drift) {
    const user = (await repository.effectiveUser("admin"))!;
    const observation = (await observeCapabilities({ repository, registries, session: erpbridgeSession, user })).observations[0]!;
    await reviewCapability({ repository, registries, session: erpbridgeSession, user, capabilityId: observation.capabilityId, body: {
      observationId: observation.id, contractHash: observation.contractHash, decisionKey: "broker-fixture-review-0001", effectClass: "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Explicit offline fixture review" } });
    // The following assertions measure business discovery/dispatch, not the
    // separate administrator observation used to establish reviewed authority.
    listTools.mockClear();
  }
  const config = { ...loadConfig({ APP_ENV: "test", JWT_SECRET: "test-broker-secret-at-least-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "mock" }),
    erpbridgeRoleMap: { "Workflow Builder": "workflow_builder" } };
  return { services: { config, repository, registries, validator, executor: new Executor(new ToolRegistry(), validator), erpbridgeSession }, callTool, listTools, authorize, tool };
}

test("approved read consumes real capability and injects only backend-mapped role", async () => {
  const s = await setup();
  const args = { id: "invoice-1" };
  await expect(dispatchReadTool(s.services, "builder", "finance.read", args)).resolves.toMatchObject({ structuredContent: { id: "invoice-1" } });
  expect(s.callTool).toHaveBeenCalledExactlyOnceWith("finance.read", { id: "invoice-1", role: "workflow_builder" });
  expect(args).toEqual({ id: "invoice-1" });
});

test.each([
  { decision: "deny" as const, source: "local_model" as const },
  { decision: "review" as const, source: "local_model" as const },
  { decision: "deny" as const, source: "local_model" as const, failureCode: "LOCAL_POLICY_RESPONSE_INVALID" as const },
])("broker policy receipt retains only allowlisted cause before SDK entry: $decision $failureCode", async outcome => {
  const s = await setup(), args = { id: "fixture" }, beforeDispatch = vi.fn(async () => {}), secret = "RAW_SECRET_SENTINEL";
  const policy = vi.spyOn(optionalPolicy, "evaluateOptionalPolicy").mockResolvedValue({ ...outcome, reason: secret, model: secret, policyVersion: secret });
  try {
    const error = await dispatchReadTool(s.services, "builder", "finance.read", args, { beforeDispatch }).catch(error => error);
    const context = { repository: s.services.repository, actorId: "builder", toolName: "finance.read", args };
    expect(observedReadPolicyFailure(error, context)).toEqual(outcome);
    expect(JSON.stringify(observedReadPolicyFailure(error, context))).not.toContain(secret);
    expect(String(error)).not.toContain(secret);
    expect(acknowledgedReadToolFailure(error)).toBeUndefined();
    expect(s.callTool).not.toHaveBeenCalled(); expect(beforeDispatch).not.toHaveBeenCalled(); expect(policy).toHaveBeenCalledOnce();
    expect(observedReadPolicyFailure(Object.assign(new Error(secret), { receipt: outcome }), context)).toBeUndefined();
    expect(observedReadPolicyFailure(JSON.parse(JSON.stringify(error)), context)).toBeUndefined();
    expect(observedReadPolicyFailure(error, { ...context, repository: new Repository(null) })).toBeUndefined();
    expect(observedReadPolicyFailure(error, { ...context, actorId: "other" })).toBeUndefined();
    expect(observedReadPolicyFailure(error, { ...context, toolName: "other" })).toBeUndefined();
    expect(observedReadPolicyFailure(error, { ...context, args: { id: "different" } })).toBeUndefined();
    Object.assign(observedReadPolicyFailure(error, context)!, { reason: secret, decision: "allow" });
    expect(observedReadPolicyFailure(error, context)).toEqual(outcome);
  } finally { policy.mockRestore(); await s.services.erpbridgeSession.close(); await s.services.repository.close(); }
});

test("only the exact governed SDK response supplies an immutable acknowledged read failure", async () => {
  const s = await setup({ remoteFailure: true });
  const error = await dispatchReadTool(s.services, "builder", "finance.read", { id: "x" }).catch(error => error);
  expect(error).toBeInstanceOf(ErpbridgeMcpToolError);
  expect(acknowledgedReadToolFailure(error)).toMatchObject({ code: "MCP_READ_TOOL_ERROR", result: { isError: true } });
  error.result.isError = false; error.result.content = [{ type: "text", text: "counterfeit success" }];
  const observed = acknowledgedReadToolFailure(error)!;
  observed.result.isError = false;
  expect(acknowledgedReadToolFailure(error)).toMatchObject({ result: { isError: true, content: [{ text: "Revision withdrawn" }] } });
  expect(s.callTool).toHaveBeenCalledOnce();
});

test.each(["constructor", "lookalike", "malformed", "old-broker-error", "direct-error"])("%s cannot establish acknowledged evidence for a new broker invocation", async scenario => {
  const s = await setup();
  let injected: unknown;
  if (scenario === "old-broker-error") {
    s.callTool.mockResolvedValueOnce({ content: [], isError: true });
    injected = await dispatchReadTool(s.services, "builder", "finance.read", { id: "first" }).catch(error => error);
    expect(acknowledgedReadToolFailure(injected)).toBeDefined();
  } else if (scenario === "direct-error") {
    s.callTool.mockResolvedValueOnce({ content: [], isError: true });
    injected = await s.services.erpbridgeSession.callToolDirect("finance.read", { id: "first" }).catch(error => error);
    expect(acknowledgedReadToolFailure(injected)).toBeUndefined();
  } else injected = scenario === "constructor" ? new ErpbridgeMcpToolError({ content: [], isError: true }) :
    Object.assign(new Error("remote supplied a class name"), { name: "ErpbridgeMcpToolError", result: { content: [], isError: true } });
  if (scenario === "malformed") s.callTool.mockResolvedValueOnce({ isError: true, content: "not an MCP content array" } as never);
  else s.callTool.mockRejectedValueOnce(injected);
  const error = await dispatchReadTool(s.services, "builder", "finance.read", { id: "second" }).catch(error => error);
  expect(error).toBeInstanceOf(Error);
  expect(acknowledgedReadToolFailure(error)).toBeUndefined();
  await s.services.erpbridgeSession.close();
});

test("captures the server-only entry guard before policy awaits instead of accepting a replaced guard", async () => {
  const s = await setup(), assertDispatch = vi.fn(() => { throw new Error("worker lease unavailable"); }), context = { assertDispatch };
  const original = s.services.validator.evaluateResolvedStep.bind(s.services.validator);
  vi.spyOn(s.services.validator, "evaluateResolvedStep").mockImplementation(async (...args) => {
    const result = await original(...args); context.assertDispatch = vi.fn(); return result;
  });
  await expect(dispatchReadTool(s.services, "builder", "finance.read", { id: "x" }, context)).rejects.toThrow("worker lease unavailable");
  expect(assertDispatch).toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
  expect(JSON.stringify(await s.services.repository.snapshot())).not.toContain("assertDispatch");
});

test("unavailable storage denies before discovery even without a queued-worker guard", async () => {
  const s = await setup(); vi.spyOn(s.services.repository, "assertAuthority").mockImplementation(() => { throw new Error("storage writer unavailable"); });
  await expect(dispatchReadTool(s.services, "builder", "finance.read", { id: "x" })).rejects.toThrow("storage writer unavailable");
  expect(s.listTools).not.toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
});

test("captures storage authority before awaited policy work rather than accepting a replaced entry method", async () => {
  const s = await setup(), guard = s.services.repository.assertAuthority.bind(s.services.repository); let unavailable = false;
  const authority = vi.spyOn(s.services.repository, "assertAuthority").mockImplementation(() => { guard(); if (unavailable) throw new Error("storage lease expired"); });
  const evaluate = s.services.validator.evaluateResolvedStep.bind(s.services.validator);
  vi.spyOn(s.services.validator, "evaluateResolvedStep").mockImplementation(async (...args) => {
    const result = await evaluate(...args); unavailable = true; s.services.repository.assertAuthority = vi.fn(); return result;
  });
  await expect(dispatchReadTool(s.services, "builder", "finance.read", { id: "x" })).rejects.toThrow("storage lease expired");
  expect(authority).toHaveBeenCalled(); expect(s.callTool).not.toHaveBeenCalled();
});

test.each([false, true])("storage loss after acknowledged intent denies final SDK entry for modern=%s without a worker hook", async modern => {
  const s = await setup(modern ? { contract, metadataComplete: true } : {}), guard = s.services.repository.assertAuthority.bind(s.services.repository); let unavailable = false;
  vi.spyOn(s.services.repository, "assertAuthority").mockImplementation(() => { guard(); if (unavailable) throw new Error("storage ownership lost at entry"); });
  await expect(dispatchReadTool(s.services, "builder", "finance.read", { id: "x" }, { beforeDispatch: async () => { await Promise.resolve(); unavailable = true; } })).rejects.toThrow("storage ownership lost at entry");
  expect(s.callTool).not.toHaveBeenCalled();
});

test("closing the repository during final intent acknowledgement cannot enter the SDK", async () => {
  const s = await setup();
  await expect(dispatchReadTool(s.services, "builder", "finance.read", { id: "x" }, { beforeDispatch: async () => { await s.services.repository.close(); } })).rejects.toThrow("closed");
  expect(s.callTool).not.toHaveBeenCalled();
});

test.each(["unknown", "role", "missing", "wrong-type", "extra", "write", "ungranted", "disabled", "no-bridge", "unsupported-schema", "nested"])("%s blocks before SDK dispatch", async (scenario) => {
  const s = await setup({ write: scenario === "write", ...(scenario === "ungranted" ? { roles: ["Platform Admin"] } : {}),
    ...(scenario === "unsupported-schema" ? { schema: { type: "object", allOf: [{ type: "object" }] } } : {}),
    ...(scenario === "nested" ? { schema: { type: "object", properties: { payload: { type: "object", properties: { amount: { type: "number" } } } } } } : {}) });
  const args: Record<string, unknown> = scenario === "missing" ? {} : scenario === "wrong-type" ? { id: 2 } : scenario === "extra" ? { id: "x", extra: true }
    : scenario === "role" ? { id: "x", role: "admin" } : scenario === "nested" ? { payload: { amount: "bad" } } : { id: "x" };
  if (scenario === "disabled") await s.services.repository.mutate((state) => { state.users.builder!.status = "Disabled"; });
  const { erpbridgeSession, ...withoutBridge } = s.services;
  await expect(dispatchReadTool(scenario === "no-bridge" ? withoutBridge : s.services, "builder", scenario === "unknown" ? "unknown" : "finance.read", args)).rejects.toThrow();
  expect(s.callTool).not.toHaveBeenCalled();
});

test("revocation during deterministic verification invalidates dispatch", async () => {
  const s = await setup();
  const original = s.services.validator.evaluateResolvedStep.bind(s.services.validator);
  vi.spyOn(s.services.validator, "evaluateResolvedStep").mockImplementation(async (...args) => {
    const result = await original(...args);
    await s.services.repository.mutate((state) => { state.users.builder!.status = "Disabled"; });
    return result;
  });
  await expect(dispatchReadTool(s.services, "builder", "finance.read", { id: "x" })).rejects.toThrow("authority changed");
  expect(s.callTool).not.toHaveBeenCalled();
});

test("MCP error envelope fails rather than becoming a successful read", async () => {
  const s = await setup({ result: { content: [{ type: "text", text: "denied" }], isError: true } });
  await expect(dispatchReadTool(s.services, "builder", "finance.read", { id: "x" })).rejects.toThrow();
  expect(s.callTool).toHaveBeenCalledTimes(1);
});

test("credential fields are removed from structured and JSON-text results before exposure", async () => {
  const s = await setup({ result: { content: [{ type: "text", text: JSON.stringify({ records: [{ id: "x", api_key: "private" }] }) }], structuredContent: { id: "x", nested: { token: "private" } } } });
  const result = await dispatchReadTool(s.services, "builder", "finance.read", { id: "x" });
  expect(JSON.stringify(result)).not.toContain("private");
  expect(result.structuredContent).toEqual({ id: "x", nested: {} });
});

const contract = { profile: "toolplane-v1" as const, resource_version: "1.2.3", resource_digest: "a".repeat(64), remote_roles: ["workflow_builder"], output_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } };
const readErrorContract = { profile: "erpbridge-read-error/v1" as const, remote_type: "not_found" as const, business_error: "ERP_RESOURCE_NOT_FOUND" as const };
const notFound = { content: [{ type: "text", text: "ERP resource not found" }], isError: true, _meta: { "com.erpbridge/error": { type: "not_found", retryable: false } } };

test("only exact reviewed read error mapping creates immutable historical business failure evidence", async () => {
  const s = await setup({ contract, readErrorContract, metadataComplete: true });
  s.callTool.mockResolvedValueOnce(notFound);
  const error = await dispatchReadTool(s.services, "builder", "finance.read", { id: "EMP002" }).catch(error => error);
  const evidence = acknowledgedReadToolFailure(error)!;
  expect(evidence.businessFailure).toMatchObject({ profile: "reviewed-read-business-failure/v1", code: "ERP_RESOURCE_NOT_FOUND",
    toolId: s.tool.tool_id, contractHash: capabilityContractHash(s.tool), admissionPin: { connectionId: "erpbridge-default", admissionVersion: 1 } });
  evidence.businessFailure!.admissionPin.revisionId = "counterfeit"; error.result._meta = {};
  expect(acknowledgedReadToolFailure(error)!.businessFailure!.admissionPin.revisionId).not.toBe("counterfeit");
  expect(s.callTool).toHaveBeenCalledOnce();
});

test.each(["no-mapping", "contradictory-hint", "malformed-dropped-hint", "extra-hint", "protocol-throw", "forged-constructor"])(
  "%s does not create reviewed business-error evidence", async scenario => {
    const s = await setup({ contract, metadataComplete: true, ...(scenario === "no-mapping" ? {} : { readErrorContract }) });
    if (scenario === "protocol-throw" || scenario === "forged-constructor") s.callTool.mockRejectedValueOnce(scenario === "protocol-throw" ?
      Object.assign(new Error("Revision not found"), { code: -32602, data: notFound._meta }) : new ErpbridgeMcpToolError(notFound));
    else s.callTool.mockResolvedValueOnce({ ...notFound, _meta: { "com.erpbridge/error": { ...notFound._meta["com.erpbridge/error"],
      ...(scenario === "contradictory-hint" ? { retryable: true } : scenario === "malformed-dropped-hint" ? { retryAfterMs: -1 } : scenario === "extra-hint" ? { continue: true } : {}) } } });
    const error = await dispatchReadTool(s.services, "builder", "finance.read", { id: "EMP002" }).catch(error => error);
    expect(acknowledgedReadToolFailure(error)?.businessFailure).toBeUndefined();
    if (!["protocol-throw", "forged-constructor"].includes(scenario)) expect(acknowledgedReadToolFailure(error)).toBeDefined();
    expect(s.callTool).toHaveBeenCalledOnce();
  });

test("read error contracts cannot use legacy session fixtures as reviewed authority", async () => {
  const s = await setup({ contract, readErrorContract });
  await expect(dispatchReadTool(s.services, "builder", "finance.read", { id: "EMP002" })).rejects.toThrow("supported reviewed");
  expect(s.callTool).not.toHaveBeenCalled();
});

test("adding an error contract after review invalidates the previous admission rather than silently upgrading it", async () => {
  const s = await setup({ contract, metadataComplete: true }); s.tool.read_error_contract = readErrorContract;
  await expect(dispatchReadTool(s.services, "builder", "finance.read", { id: "EMP002" })).rejects.toThrow("no unique admitted");
  expect(s.callTool).not.toHaveBeenCalled();
});

test("an admission change during final verification fences the captured business-error review pin", async () => {
  const s = await setup({ contract, readErrorContract, metadataComplete: true }), original = s.authorize.getMockImplementation()!;
  let count = 0;
  s.authorize.mockImplementation(async (...args) => {
    await original(...args);
    if (++count === 2) await s.services.repository.mutate(state => {
      const admission = Object.values(state.capabilityAdmissions)[0]!; admission.version = Number(admission.version) + 1;
    });
  });
  await expect(dispatchReadTool(s.services, "builder", "finance.read", { id: "EMP002" })).rejects.toThrow("changed");
  expect(s.callTool).not.toHaveBeenCalled();
});
test.each(["actor", "role-map"])("noncollection dispatch also rechecks %s after the final awaited review", async change => {
  const s = await setup({ contract, metadataComplete: true }), original = s.authorize.getMockImplementation()!; let armed = false;
  const evaluate = s.services.validator.evaluateResolvedStep.bind(s.services.validator);
  vi.spyOn(s.services.validator, "evaluateResolvedStep").mockImplementation(async (...args) => { const value = await evaluate(...args); armed = true; return value; });
  s.authorize.mockImplementation(async (...args) => { await original(...args); if (!armed) return; armed = false;
    if (change === "actor") await s.services.repository.mutate(state => { state.users.builder!.status = "Disabled"; });
    else s.services.config.erpbridgeRoleMap["Workflow Builder"] = "changed";
  });
  await expect(dispatchReadTool(s.services, "builder", "finance.read", { id: "x" })).rejects.toThrow(); expect(s.callTool).not.toHaveBeenCalled();
});
test("production-like guarded dispatch pins exact revision and digest with no second discovery round trip", async () => {
  const s = await setup({ contract, metadataComplete: true });
  const output = await dispatchReadTool(s.services, "builder", "finance.read", { id: "invoice-1" });
  expect(output).toMatchObject({ _meta: { "io.workflow-engine/dispatch": { remoteName: "finance.read.rev_MS4yLjM", resourceVersion: "1.2.3", resourceDigest: "a".repeat(64) } } });
  expect(s.callTool).toHaveBeenCalledExactlyOnceWith("finance.read.rev_MS4yLjM", { id: "invoice-1", role: "workflow_builder" }, { "toolplane.resourceDigest": "a".repeat(64) });
  expect(s.listTools).toHaveBeenCalledOnce();
});
test("open bridge tools preserve a legitimate business role but still enforce local grants", async () => {
  const schema = { type: "object", properties: { role: { type: "string" } }, required: ["role"], additionalProperties: false };
  const s = await setup({ contract: { ...contract, remote_roles: [] }, metadataComplete: true, schema });
  await dispatchReadTool(s.services, "builder", "finance.read", { role: "customer" });
  expect(s.callTool).toHaveBeenCalledExactlyOnceWith("finance.read.rev_MS4yLjM", { role: "customer" }, { "toolplane.resourceDigest": "a".repeat(64) });
  const denied = await setup({ contract: { ...contract, remote_roles: [] }, metadataComplete: true, schema, roles: ["Platform Admin"] });
  await expect(dispatchReadTool(denied.services, "builder", "finance.read", { role: "customer" })).rejects.toThrow(); expect(denied.callTool).not.toHaveBeenCalled();
});
test.each(["no-review", "digest-drift", "wrong-role", "injected-role", "output-mismatch", "withdrawn"])("modern bridge contract %s denies/fails without alias fallback or replay", async scenario => {
  const s = await setup({ metadataComplete: true, ...(scenario === "no-review" ? {} : { contract: { ...contract, remote_roles: scenario === "wrong-role" ? ["finance_reader"] : contract.remote_roles } }),
    drift: scenario === "digest-drift", remoteFailure: scenario === "withdrawn", ...(scenario === "output-mismatch" ? { result: { content: [], structuredContent: { id: 1 } } } : {}) });
  await expect(dispatchReadTool(s.services, "builder", "finance.read", { id: "invoice-1", ...(scenario === "injected-role" ? { role: "admin" } : {}) })).rejects.toThrow();
  expect(s.callTool).toHaveBeenCalledTimes(["withdrawn", "output-mismatch"].includes(scenario) ? 1 : 0);
  if (s.callTool.mock.calls.length) expect((s.callTool.mock.calls as unknown[][])[0]![0]).toBe("finance.read.rev_MS4yLjM");
});
test("modern direct policy path rejects business tools and absent policy contracts", async () => {
  const s = await setup({ contract, metadataComplete: true });
  for (const name of ["finance.read", "check_policy", "policy-gate-evaluate", "policy-gate-assist"])
    await expect(s.services.erpbridgeSession.callToolDirect(name, {})).rejects.toThrow();
  expect(s.callTool).not.toHaveBeenCalled();
});

test.each(["loop", "v3-without-loop", "malformed"])("%s cannot enter SDK dispatch through legacy flat completed-node evidence", async scenario => {
  const s = await setup(), action = { kind: "action", nodeId: "read" }, root = { kind: "sequence", nodes: scenario === "loop" ? [{ kind: "foreach", id: "each", items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "workflowInput", path: ["rows"] } }, maxItems: 3, body: { kind: "sequence", nodes: [action] }, collect: { schema: { type: "string" }, value: { kind: "literal", value: "done" } } }] : [action] };
  const yaml = stringify({ name: "Collection", description: "A fake DONE declaration is not iteration proof", trigger: { type: "manual" }, steps: [{ id: "read", action: "finance.read", parameters: { id: "x" } }], metadata: { controlFlow: { schemaVersion: "read-control-flow/v3", root: scenario === "malformed" ? "wrong" : root } } });
  const gate = await s.services.validator.validateAndIssueToken("Fixture", yaml, "Workflow Builder"); expect(gate.token).not.toBeNull();
  await s.services.repository.mutate(state => { state.executions.run = { id: "run", status: "RUNNING", workflowSnapshot: { yaml }, readProgress: { ...newReadProgress(s.services.repository), attempts: { read: { id: "fake", nodeId: "read", stepIndex: 0, status: "DONE", startedAt: new Date().toISOString() } } } } as any; });
  await expect(dispatchReadTool(s.services, "builder", "finance.read", { id: "x" }, { executionId: "run", plan: { yaml, stepIndex: 0, token: gate.token! } })).rejects.toThrow();
  expect(s.callTool).not.toHaveBeenCalled();
});

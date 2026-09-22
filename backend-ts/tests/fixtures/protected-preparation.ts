import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { stringify } from "yaml";
import { vi } from "vitest";
import { Repository } from "../../src/repository/store.js";
import { RegistryService } from "../../src/registry/service.js";
import { RegistryValidator } from "../../src/validator/registry-validator.js";
import { loadConfig } from "../../src/config/config.js";
import { Executor } from "../../src/runner/executor.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createErpbridgeMcpSession } from "../../src/tools/erpbridge-mcp-client.js";
import { admissionAuthorizer, observeCapabilities, reviewCapability, capabilityContractHash } from "../../src/registry/capability-admission.js";
import { exactBridgeName, bridgeTransportSchema } from "../../src/tools/erpbridge-contract.js";
import { ProviderRuntime } from "../../src/providers/runtime.js";
import { buildApp } from "../../src/http/app.js";
import type { HandlerServices } from "../../src/http/handlers/common.js";
import { toolSchema } from "../../src/registry/schemas.js";
import { updateRuntimeApprovalPolicy } from "../../src/runner/runtime-approvals.js";
import { protectedSimulationRead, protectedSimulationSource, fixtureSequence as seq, fixtureRef as ref } from "./protected-simulation.js";

/** Real session/review/compiler and HTTP wiring with synthetic SDK/model I/O.
 * No durable-worker, live network or business-operation qualification. */
export async function protectedPreparationFixture(kind?: "analysis" | "agent" | "effect", withReadback = false) {
  const repository = await Repository.open(null), registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json"));
  const tools = [structuredClone(protectedSimulationRead)], base = registries.snapshot();
  const { read_error_contract: _readError, ...effectBase } = tools[0]!;
  if (kind === "effect") tools.push(toolSchema.parse({ ...effectBase, tool_id: "protected-effect", name: "hr.notify", mcp_tool_name: "hr.notify", is_read_only: false,
    side_effects: ["Synthetic notification"], operation_contract: { profile: "operation-result/v1", effect_class: "notification", retry_policy: "never",
      confirmation: { path: ["accepted"], expected: true, meaning: "operation-accepted" } },
    bridge_contract: { ...tools[0]!.bridge_contract!, resource_digest: "b".repeat(64), output_schema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"], additionalProperties: false } } }));
  if (withReadback) {
    const readback = toolSchema.parse({ ...effectBase, tool_id: "protected-readback", name: "hr.status", mcp_tool_name: "hr.status", allowed_roles: ["ERP Recovery"],
      bridge_contract: { ...tools[0]!.bridge_contract!, remote_roles: ["recovery"], resource_digest: "c".repeat(64), output_schema: { type: "object", properties: {
        id: { type: "string" }, state: { type: "string" }, settled: { type: "boolean" }, observedAt: { type: "string" } }, required: ["id", "state", "settled", "observedAt"], additionalProperties: false } } });
    tools.push(readback);
    tools[1]!.operation_contract!.readback = { profile: "operation-readback-contract/v1", tool_id: readback.tool_id, contract_hash: capabilityContractHash(readback),
      arguments: [{ parameter: "id", source_path: ["id"] }], correlation: [{ source_path: ["id"], result_path: ["id"] }],
      outcome: { path: ["state"], applied: "APPLIED", not_applied: "ABSENT" }, settled_path: ["settled"], observed_at_path: ["observedAt"], max_age_seconds: 60, evidence_meaning: "operation-state" };
  }
  vi.spyOn(registries, "snapshot").mockImplementation(() => ({ ...base, tools }));
  vi.spyOn(registries, "findTool").mockImplementation(name => tools.find(tool => [tool.tool_id, tool.name, tool.mcp_tool_name].includes(name)));
  vi.spyOn(registries, "hash").mockImplementation(() => capabilityContractHash(toolSchema.parse({ ...tools[0], execution_notes: tools.map(capabilityContractHash).join(":") })));
  const config = loadConfig({ APP_ENV: "test", JWT_SECRET: "protected-preparation-secret-at-least-32", MCP_MODE: "mock", STORAGE_DRIVER: "memory", STORAGE_ENCRYPTION_KEY: "x".repeat(32) });
  config.erpbridgeRoleMap = { "Platform Admin": "admin" };
  const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
  let toolsChanged = () => {}, discoveryHook: (() => Promise<void>) | undefined;
  const sdk = { metadataComplete: true, connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
    onToolsChanged: (callback: () => void) => { toolsChanged = callback; return () => {}; },
    listTools: vi.fn(async () => { await discoveryHook?.(); return tools.map(tool => ({ name: exactBridgeName(tool), inputSchema: bridgeTransportSchema(tool), outputSchema: tool.bridge_contract!.output_schema!,
      _meta: { "toolplane.resourceDigest": tool.bridge_contract!.resource_digest, "toolplane.resourceVersion": "1.0.0", "io.erpbridge/allowedRoles": tool.bridge_contract!.remote_roles } })); }),
    callTool: vi.fn(async () => { throw new Error("Preparation must never enter SDK execution"); }) };
  const session = await createErpbridgeMcpSession({ baseURL: "https://synthetic.example.test", token: "private-synthetic-token", timeoutMs: 1000,
    validator, sdkClient: sdk, admissionAuthorizer: admissionAuthorizer(repository, registries) });
  const source = protectedSimulationSource(), group = source.metadata.controlFlow.root.nodes[0]; source.steps.pop();
  source.steps[0].parameters.id = "{{each.item}}";
  source.metadata.controlFlow.root = seq({ kind: "foreach", id: "each", maxItems: 3,
    items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "workflowInput", path: ["items"] } },
    body: seq(group), collect: { schema: { type: "string" }, value: ref("guard", "value") } },
    { kind: "return", id: "answer", output: { schema: { type: "array", items: { type: "string" } }, value: ref("each", "value") } });
  source.trigger.config = { inputSchema: { type: "object", properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"], additionalProperties: false } };
  if (kind === "analysis" || kind === "agent") source.steps[1] = { id: "body_next", kind, instruction: "Return acknowledged text", input: "{{lookup.structuredContent.text}}", model: "fixture-model",
    output_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, data_class: "restricted",
    ...(kind === "agent" ? { allowed_actions: [tools[0]!.name], completion_predicate: { path: ["text"], equals: "complete" }, max_rounds: 2, max_tool_calls: 1 } : {}) };
  if (kind === "effect") { source.steps.splice(2, 0, { id: "send", action: tools[1]!.name, parameters: { id: "{{body_next.structuredContent.text}}" } }); group.body.nodes.push({ kind: "action", nodeId: "send" }); }
  await repository.mutate(state => {
    const now = new Date().toISOString();
    state.users.requester = { id: "requester", name: "requester", email: "requester@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "F", departmentId: null, lastLoginAt: null, createdAt: now };
    state.roles.review = { id: "review", name: "Independent approver", description: "Review only", permissions: ["execution:approve"], createdAt: now };
    state.workflows.flow = { id: "flow", name: "Protected preparation", description: "Synthetic only", owner: { id: "requester", name: "requester" }, assignedUserIds: [], status: "Validated", trigger: { type: "manual" },
      steps: source.steps.length, successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt: now, updatedAt: now, yaml: stringify(source), archived: false };
    state.versions.flow = [];
  });
  const actor = (await repository.effectiveUser("requester"))!;
  if (kind === "effect") await repository.mutate(state => updateRuntimeApprovalPolicy(state, actor, { profile: "runtime-approval-policy/v1", baseRevision: 0, enabled: true, approverRoleIds: ["review"], ttlSeconds: 300, separationOfDuties: true }));
  const observations = (await observeCapabilities({ repository, registries, session, user: actor })).observations;
  for (const observation of observations) await reviewCapability({ repository, registries, session, user: actor, capabilityId: observation.capabilityId, body: {
    observationId: observation.id, contractHash: observation.contractHash, decisionKey: `review-${observation.toolId}`, effectClass: observation.toolId === "protected-effect" ? "notification" : "read",
    riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Explicit synthetic preparation review", ...(observation.toolId === "protected-effect" ? { requireIndependentApproval: true } : {}) } });
  const modelFetch = vi.fn(async () => { throw new Error("Preparation must never call a model"); }), providerRuntime = new ProviderRuntime(repository, executor, modelFetch as typeof fetch);
  if (kind === "analysis" || kind === "agent") providerRuntime.activate({ id: "fixture-provider", name: "Synthetic provider", type: "openai_compatible", baseURL: "https://model.example.test/v1", apiKey: "private-model-key",
    model: "fixture-model", additionalModels: ["other-model"], temperature: 0, timeoutMs: 1000, egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://model.example.test",
      runtimeAnalysisDataClasses: ["restricted"], runtimeAgentDataClasses: ["restricted"], interactiveDataClasses: [], reviewedAt: "2026-10-09T00:00:00.000Z", reviewedBy: { id: actor.id, name: actor.name } } });
  const services: HandlerServices = { repository, registries, config, validator, executor, erpbridgeSession: session, providerRuntime }, app = await buildApp(services);
  const request = (method: "GET" | "POST", url: string, payload?: object) => app.inject({ method, url, headers: { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { subject: actor.id, expiresIn: 3600 })}` }, ...(payload ? { payload } : {}) });
  return { repository, registries, config, source, services, app, actor, tools, sdk, session, providerRuntime, modelFetch, request, toolsChanged: () => toolsChanged(),
    setDiscoveryHook: (hook: () => Promise<void>) => { discoveryHook = hook; },
    saveSource: () => repository.mutate(state => { state.workflows.flow!.yaml = stringify(source); }),
    close: async () => { await app.close(); await session.close(); await repository.close(); } };
}

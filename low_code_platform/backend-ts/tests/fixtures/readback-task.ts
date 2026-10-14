import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { stringify } from "yaml";
import { expect, vi } from "vitest";
import { loadConfig } from "../../src/config/config.js";
import { Repository } from "../../src/repository/store.js";
import { RegistryService } from "../../src/registry/service.js";
import { toolSchema } from "../../src/registry/schemas.js";
import { RegistryValidator } from "../../src/validator/registry-validator.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { Executor } from "../../src/runner/executor.js";
import { createErpbridgeMcpSession } from "../../src/tools/erpbridge-mcp-client.js";
import { bridgeTransportSchema, exactBridgeName } from "../../src/tools/erpbridge-contract.js";
import { admissionAuthorizer, observeCapabilities, reviewCapability, capabilityContractHash } from "../../src/registry/capability-admission.js";
import { updateRuntimeApprovalPolicy } from "../../src/runner/runtime-approvals.js";
import { operationReadbackQueue, operationReadbackHistory } from "../../src/runner/operation-readback-jobs.js";
import { bindExecutionHost } from "../../src/runner/execution-host.js";
import { configureReadbackTaskDispatch, type ReadbackTaskCommand, type ReadbackTaskTransport } from "../../src/runner/readback-task-outbox.js";
import { buildApp } from "../../src/http/app.js";
import { TaskRecords } from "./bounded-read-task.js";

/** Creates a genuinely admitted/reviewed uncertain operation via the resident
 * API, then reopens its fixture records under a fresh bounded owner. No real
 * queue, encryption, ERP send or provider is implied by this test fixture. */
export async function readbackTaskFixture(options: { records?: TaskRecords; configure?: boolean; timeoutMs?: number; enqueue?: ReadbackTaskTransport["enqueue"] } = {}) {
  const records = options.records ?? new TaskRecords();
  const config = { ...loadConfig({ APP_ENV: "test", MCP_MODE: "mock", STORAGE_DRIVER: "memory", STORAGE_ENCRYPTION_KEY: "x".repeat(32),
    JWT_SECRET: "readback-task-fixture-secret-32-characters" }), readWorkerLeaseMs: 5000 };
  const registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json")), base = registries.snapshot();
  const target = toolSchema.parse({ ...base.tools[0]!, tool_id: "readback-fixture", name: "demo.status", mcp_tool_name: "demo.status", is_read_only: true,
    risk_level: "low", side_effects: [], allowed_roles: ["Platform Admin"], input_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
    bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [], output_schema: { type: "object",
      properties: { value: { type: "string" }, state: { type: "string" }, settled: { type: "boolean" }, observedAt: { type: "string" } },
      required: ["value", "state", "settled", "observedAt"], additionalProperties: false } } });
  const effect = toolSchema.parse({ ...target, tool_id: "send-fixture", name: "demo.dispatch", mcp_tool_name: "demo.dispatch", is_read_only: false,
    side_effects: ["Synthetic notification"], operation_contract: { profile: "operation-result/v1", effect_class: "notification", retry_policy: "never",
      confirmation: { path: ["accepted"], expected: true, meaning: "operation-accepted" }, readback: { profile: "operation-readback-contract/v1", tool_id: target.tool_id,
        contract_hash: capabilityContractHash(target), arguments: [{ parameter: "value", source_path: ["value"] }], correlation: [{ source_path: ["value"], result_path: ["value"] }],
        outcome: { path: ["state"], applied: "APPLIED", not_applied: "ABSENT" }, settled_path: ["settled"], observed_at_path: ["observedAt"], max_age_seconds: 60, evidence_meaning: "operation-state" } },
    bridge_contract: { ...target.bridge_contract, resource_digest: "b".repeat(64), output_schema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"], additionalProperties: false } } });
  const tools = [target, effect];
  vi.spyOn(registries, "snapshot").mockImplementation(() => ({ ...base, tools }));
  vi.spyOn(registries, "findTool").mockImplementation(name => tools.find(tool => [tool.tool_id, tool.name, tool.mcp_tool_name].includes(name)));
  vi.spyOn(registries, "hash").mockImplementation(() => capabilityContractHash(effect));
  const sdk = { metadataComplete: true, connect: vi.fn(async () => {}), close: vi.fn(async () => {}), listTools: vi.fn(async () => tools.map(tool => ({ name: exactBridgeName(tool), inputSchema: bridgeTransportSchema(tool),
    outputSchema: tool.bridge_contract!.output_schema!, _meta: { "toolplane.resourceDigest": tool.bridge_contract!.resource_digest, "toolplane.resourceVersion": "1.0.0", "io.erpbridge/allowedRoles": [] } }))),
    callTool: vi.fn(async (name: string, args: Record<string, unknown>): Promise<unknown> => {
      if (name === exactBridgeName(effect)) throw new Error("Synthetic original outcome unknown; never resend");
      return { content: [], structuredContent: { value: args.value, state: "ABSENT", settled: true, observedAt: new Date().toISOString() } };
    }) };
  async function open() {
    const repository = await Repository.open(records), validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
    const session = await createErpbridgeMcpSession({ baseURL: "https://readback.example.test", token: "synthetic-stable-token", timeoutMs: 1000, validator, sdkClient: sdk,
      admissionAuthorizer: admissionAuthorizer(repository, registries) });
    return { repository, session, services: { repository, validator, executor, config, registries, erpbridgeSession: session } };
  }
  if (!records.bytes) {
    const source = await open(), { repository, services, session } = source;
    try {
      await repository.mutate(state => {
        const now = new Date().toISOString();
        state.roles.review = { id: "review", name: "Independent approver", description: "Review only", permissions: ["execution:approve"], createdAt: now };
        for (const id of ["requester", "reviewer"]) state.users[id] = { id, name: id, email: `${id}@example.test`, roleId: id === "reviewer" ? "review" : "role_admin",
          permissionOverrides: [], status: "Active", initials: "F", departmentId: null, lastLoginAt: null, createdAt: now };
        const yaml = stringify({ name: "Uncertain original", description: "Synthetic send fixture", trigger: { type: "manual" }, steps: [{ id: "send", action: effect.name, parameters: { value: "original" } }] });
        state.workflows.flow = { id: "flow", name: "Uncertain original", description: "", owner: { id: "requester", name: "requester" }, assignedUserIds: [], status: "Validated",
          trigger: { type: "manual" }, steps: 1, successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false,
          createdAt: now, updatedAt: now, yaml, archived: false }; state.versions.flow = [];
      });
      const actor = (await repository.effectiveUser("requester"))!;
      await repository.mutate(state => updateRuntimeApprovalPolicy(state, actor, { profile: "runtime-approval-policy/v1", baseRevision: 0, enabled: true, approverRoleIds: ["review"], ttlSeconds: 300, separationOfDuties: true }));
      for (const observation of (await observeCapabilities({ repository, registries, session, user: actor })).observations)
        await reviewCapability({ repository, registries, session, user: actor, capabilityId: observation.capabilityId, body: { observationId: observation.id, contractHash: observation.contractHash,
          decisionKey: `fixture-review-${observation.toolId}`, effectClass: observation.toolId === effect.tool_id ? "notification" : "read", riskClass: "low", dataClass: "internal", retryPolicy: "never",
          note: "Synthetic reviewed contract", ...(observation.toolId === effect.tool_id ? { requireIndependentApproval: true } : {}) } });
      const app = await buildApp(services);
      try {
        const request = (url: string, payload: object, actorId = "requester") => app.inject({ method: "POST", url, payload,
          headers: { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { subject: actorId, expiresIn: 3600 })}` } });
        const published = await request("/api/workflows/flow/publish", {}); expect(published.statusCode, published.body).toBe(200);
        const admitted = await request("/api/workflows/flow/run", { mode: "async-operation", idempotencyKey: "original-uncertain-fixture-001", input: {} }); expect(admitted.statusCode, admitted.body).toBe(202);
        const id = admitted.json().data.id;
        await vi.waitFor(async () => expect((await repository.snapshot()).executions[id]!.status).toBe("AWAITING_APPROVAL"));
        const review = await app.inject({ method: "GET", url: `/api/executions/${id}?view=approval`, headers: { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { subject: "reviewer", expiresIn: 3600 })}` } });
        const approval = review.json().data.runtimeApproval;
        const approved = await request(`/api/executions/${id}/approve`, { approvalId: approval.id, baseVersion: approval.version, reviewHash: approval.reviewHash, decisionKey: "fixture-approval-0001" }, "reviewer");
        expect(approved.statusCode, approved.body).toBe(200);
        await vi.waitFor(async () => expect((await repository.snapshot()).executions[id]!.status).toBe("RECONCILIATION_REQUIRED"));
      } finally { await app.close(); }
    } finally { await session.close(); await repository.close(); }
  }
  const owned = await open(), { repository, services } = owned;
  bindExecutionHost(repository, "bounded-invocation");
  const sent: ReadbackTaskCommand[] = [], enqueue = vi.fn<ReadbackTaskTransport["enqueue"]>(options.enqueue ?? (async command => {
    sent.push(structuredClone(command)); return { taskId: command.taskId, outcome: "CREATED" };
  }));
  if (options.configure !== false) configureReadbackTaskDispatch(repository, { enqueue, timeoutMs: options.timeoutMs ?? 1000 });
  const app = await buildApp(services, { executionHost: "bounded-invocation" }), actor = (await repository.effectiveUser("requester"))!;
  const id = (await repository.read(state => Object.keys(state.executions)))[0]!, queue = operationReadbackQueue(services);
  const headers = { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { subject: actor.id, expiresIn: 3600 })}` };
  const history = () => repository.readAuthoritative(state => operationReadbackHistory(state, services, id, actor.id));
  const admit = async (key = "readback-query-original-key-001") => { const value = await history(); return queue.admit(id, actor, { intentId: value.intentId, baseVersion: value.baseVersion, factsHash: value.factsHash, idempotencyKey: key }); };
  const close = async () => { await app.close(); await owned.session.close(); await repository.close(); };
  return { ...owned, records, sdk, target, effect, id, actor, app, headers, sent, enqueue, history, admit, queue, close };
}

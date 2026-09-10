import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import jwt from "jsonwebtoken";
import { stringify } from "yaml";
import { loadConfig } from "../src/config/config.js";
import { openApplicationRepository } from "../src/storage/open-repository.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { FirestoreRecordCodec } from "../src/storage/firestore-record-codec.js";
import { FirestoreRecordStore } from "../src/storage/firestore-record-store.js";
import { assembleFirestoreState } from "../src/storage/firestore-record-layout.js";
import { boundedOperation } from "../src/core/bounded-operation.js";
import { buildApp } from "../src/http/app.js";
import { toolSchema } from "../src/registry/schemas.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { SynthesisService } from "../src/synthesis/service.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { exactBridgeName, bridgeTransportSchema } from "../src/tools/erpbridge-contract.js";
import { capabilityContractHash, admissionAuthorizer, observeCapabilities, reviewCapability } from "../src/registry/capability-admission.js";
import { dispatchReadTool } from "../src/tools/read-tool-broker.js";
import { evaluateOperationReadback, resolveOperationReadbackArguments } from "../src/tools/operation-readback-contract.js";
import { workflowContentHash, parseWorkflowYAMLStrict } from "../src/parser/workflow.js";
import { requestRuntimeApproval, runtimeApprovalPolicyHash, consumeRuntimeApproval } from "../src/runner/runtime-approvals.js";
import { reportWindowFor, workflowScheduleRunner } from "../src/runner/workflow-schedules.js";
import { newReadProgress } from "../src/runner/read-checkpoints.js";
import { canonicalJSONBytes, resolvedParameterHashBytes } from "../src/core/canonical-json.js";

// Every SDK database call targets a fresh synthetic workspace in this exact
// local demo emulator. Provider/MCP transports below are explicit in-process
// fixtures, never network fallback or live-effect clients.
const projectId = "demo-lcwe-records";
if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:23671" || process.env.GCLOUD_PROJECT !== projectId || process.env.GOOGLE_APPLICATION_CREDENTIALS)
  throw new Error("Guarded demo project, fixed loopback Firestore emulator and no credential file are required");
process.env.NODE_ENV = "test";
const key = randomBytes(32).toString("base64"), namespace = { projectId, databaseId: "(default)", workspaceId: `test_${randomUUID().replaceAll("-", "")}_runtime` };
const config = loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "firestore-records", FIRESTORE_PROJECT_ID: projectId, FIRESTORE_DATABASE_ID: namespace.databaseId,
  FIRESTORE_WORKSPACE_ID: namespace.workspaceId, STORAGE_ENCRYPTION_KEY: key, MCP_MODE: "mock", MCP_TRANSPORT: "erpbridge-mcp", MCP_TIMEOUT_MS: "10000",
  ERPBRIDGE_BASE_URL: "https://isolated.fixture.example.test", ERPBRIDGE_MCP_TOKEN: "fixture-only-not-a-real-token", ERPBRIDGE_ROLE_MAP: JSON.stringify({ "Platform Admin": "platform_admin" }), JWT_SECRET: "isolated-firestore-runtime-fixture-secret-32-bytes" });
const codec = new FirestoreRecordCodec(key, namespace), log = value => console.log(`PASS: ${value}`);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const ownedBarriers = [];
const barrier = () => { let release; const promise = new Promise(resolve => { release = resolve; }); const gate = { promise, release }; ownedBarriers.push(gate); return gate; };
const sequential = stringify({ name: "Firestore report", description: "Read exact fixture data", trigger: { type: "manual" }, steps: [{ id: "lookup", action: "read", parameters: { id: "{{input.id}}" } }] });
const collection = stringify({ name: "Firestore collection", description: "Bounded invoice fixture", trigger: { type: "manual" }, steps: [{ id: "lookup", action: "read", parameters: { id: "{{each.item}}" } }], metadata: { controlFlow: { schemaVersion: "read-control-flow/v3", root: { kind: "sequence", nodes: [
  { kind: "foreach", id: "each", items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "workflowInput", path: ["rows"] } }, maxItems: 3,
    body: { kind: "sequence", nodes: [{ kind: "action", nodeId: "lookup" }] }, collect: { schema: { type: "string" }, value: { kind: "ref", source: "nodeOutput", nodeId: "lookup", path: ["structuredContent", "id"] } } },
  { kind: "return", id: "answer", output: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "nodeOutput", nodeId: "each", path: ["value"] } } },
] } } } });
const tool = toolSchema.parse({ tool_id: "FIXTURE-READ", name: "read", mcp_tool_name: "read", is_read_only: true, allowed_roles: ["Platform Admin"], risk_level: "low", side_effects: [],
  input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: ["platform_admin"] } });
const reportTool = toolSchema.parse({ ...tool, tool_id: "FIXTURE-REPORT", name: "fixture.report", mcp_tool_name: "fixture.report",
  input_schema: { type: "object", properties: { startAt: { type: "string" }, endAt: { type: "string" }, cursor: { type: "string" } }, required: ["startAt", "endAt"], additionalProperties: false },
  report_coverage_contract: { profile: "report-coverage/v1", start_parameter: "startAt", end_parameter: "endAt", covered_start_path: ["coveredStartAt"],
    covered_end_path: ["coveredEndAt"], complete_path: ["complete"], has_more_path: ["hasMore"], items_path: ["items"], item_count_path: ["itemCount"],
    pagination: { profile: "opaque-cursor/v1", cursor_parameter: "cursor", cursor_path: ["cursor"], next_cursor_path: ["nextCursor"], snapshot_path: ["snapshotId"],
      total_count_path: ["totalAvailable"], initial_cursor: "", max_pages: 4, max_items: 100 } },
  bridge_contract: { ...tool.bridge_contract, resource_digest: "e".repeat(64), output_schema: { type: "object", properties: {
    coveredStartAt: { type: "string" }, coveredEndAt: { type: "string" }, complete: { type: "boolean" }, hasMore: { type: "boolean" },
    items: { type: "array", maxItems: 100, items: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
    itemCount: { type: "integer" }, reportId: { type: "string" }, cursor: { type: "string" }, nextCursor: { type: "string" }, snapshotId: { type: "string" }, totalAvailable: { type: "integer" } },
    required: ["coveredStartAt", "coveredEndAt", "complete", "hasMore", "items", "itemCount", "reportId", "cursor", "nextCursor", "snapshotId", "totalAvailable"], additionalProperties: false } } });
const relatedInvoiceTool = toolSchema.parse({ ...tool, tool_id: "FIXTURE-INVOICE-RELATION-REPORT", name: "fixture.invoice-relation-report", mcp_tool_name: "fixture.invoice-relation-report",
  input_schema: { type: "object", properties: { startAt: { type: "string" }, endAt: { type: "string" } }, required: ["startAt", "endAt"], additionalProperties: false },
  report_coverage_contract: { profile: "report-coverage/v1", business_resource: "invoices", start_parameter: "startAt", end_parameter: "endAt", covered_start_path: ["coveredStartAt"],
    covered_end_path: ["coveredEndAt"], complete_path: ["complete"], has_more_path: ["hasMore"], items_path: ["items"], item_count_path: ["itemCount"],
    key_projection: { profile: "report-key-projection/v1", relation_name: "invoice-orders", item_key_path: ["orderId"], keys_path: ["orderIds"] } },
  bridge_contract: { ...tool.bridge_contract, resource_digest: "f".repeat(64), output_schema: { type: "object", properties: {
    coveredStartAt: { type: "string" }, coveredEndAt: { type: "string" }, complete: { type: "boolean" }, hasMore: { type: "boolean" },
    items: { type: "array", items: { type: "object", properties: { invoiceId: { type: "string" }, orderId: { type: "string" } },
      required: ["invoiceId", "orderId"], additionalProperties: false } }, itemCount: { type: "integer" },
    orderIds: { type: "array", maxItems: 100, items: { type: "string" } }, reportId: { type: "string" } },
    required: ["coveredStartAt", "coveredEndAt", "complete", "hasMore", "items", "itemCount", "orderIds", "reportId"], additionalProperties: false } } });
const relatedOrderTool = toolSchema.parse({ ...tool, tool_id: "FIXTURE-ORDER-RELATION-REPORT", name: "fixture.order-relation-report", mcp_tool_name: "fixture.order-relation-report",
  input_schema: { type: "object", properties: { startAt: { type: "string" }, endAt: { type: "string" },
    orderIds: { type: "array", maxItems: 100, items: { type: "string" } } }, required: ["startAt", "endAt", "orderIds"], additionalProperties: false },
  report_coverage_contract: { profile: "report-coverage/v1", business_resource: "orders", start_parameter: "startAt", end_parameter: "endAt", covered_start_path: ["coveredStartAt"],
    covered_end_path: ["coveredEndAt"], complete_path: ["complete"], has_more_path: ["hasMore"], items_path: ["items"], item_count_path: ["itemCount"],
    requested_key_coverage: { profile: "report-requested-key-coverage/v1", relation_name: "invoice-orders", keys_parameter: "orderIds", item_key_path: ["orderId"] } },
  bridge_contract: { ...tool.bridge_contract, resource_digest: "1".repeat(64), output_schema: { type: "object", properties: {
    coveredStartAt: { type: "string" }, coveredEndAt: { type: "string" }, complete: { type: "boolean" }, hasMore: { type: "boolean" },
    items: { type: "array", items: { type: "object", properties: { orderId: { type: "string" }, total: { type: "integer" } },
      required: ["orderId", "total"], additionalProperties: false } }, itemCount: { type: "integer" }, reportId: { type: "string" } },
    required: ["coveredStartAt", "coveredEndAt", "complete", "hasMore", "items", "itemCount", "reportId"], additionalProperties: false } } });
const readbackTool = toolSchema.parse({ ...tool, tool_id: "FIXTURE-NOTIFICATION-STATUS", name: "fixture.notification-status", mcp_tool_name: "fixture.notification-status",
  bridge_contract: { ...tool.bridge_contract, resource_digest: "c".repeat(64), output_schema: { type: "object", properties: {
    id: { type: "string" }, state: { type: "string" }, settled: { type: "boolean" }, observedAt: { type: "string" },
  }, required: ["id", "state", "settled", "observedAt"], additionalProperties: false } } });
const operationTool = toolSchema.parse({ ...tool, tool_id: "FIXTURE-NOTIFICATION", name: "fixture.notification", mcp_tool_name: "fixture.notification", is_read_only: false, side_effects: ["Synthetic notification acknowledgement"],
  operation_contract: { profile: "operation-result/v1", effect_class: "notification", retry_policy: "never", confirmation: { path: ["accepted"], expected: true, meaning: "operation-accepted" }, readback: {
    profile: "operation-readback-contract/v1", tool_id: readbackTool.tool_id, contract_hash: capabilityContractHash(readbackTool),
    arguments: [{ parameter: "id", source_path: ["id"] }], correlation: [{ source_path: ["id"], result_path: ["id"] }],
    settled_path: ["settled"], observed_at_path: ["observedAt"], max_age_seconds: 60,
    outcome: { path: ["state"], applied: "APPLIED", not_applied: "ABSENT" }, evidence_meaning: "operation-state",
  } },
  bridge_contract: { ...tool.bridge_contract, resource_digest: "b".repeat(64), output_schema: { type: "object", properties: { accepted: { type: "boolean" }, id: { type: "string" } }, required: ["accepted", "id"], additionalProperties: false } } });
const emailTool = toolSchema.parse({ ...operationTool, tool_id: "FIXTURE-EMAIL", name: "fixture.email", mcp_tool_name: "fixture.email", side_effects: ["Synthetic email acceptance"],
  input_schema: { type: "object", properties: { recipient: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["recipient", "subject", "body"], additionalProperties: false },
  email_delivery_contract: { profile: "email-delivery-input/v1", recipient_parameter: "recipient", subject_parameter: "subject", body_parameter: "body" },
  operation_contract: { profile: "operation-result/v1", effect_class: "notification", retry_policy: "never",
    confirmation: { path: ["accepted"], expected: true, meaning: "operation-accepted" } },
  bridge_contract: { ...operationTool.bridge_contract, resource_digest: "d".repeat(64) } });
const fixtureTools = [tool, reportTool, relatedInvoiceTool, relatedOrderTool, operationTool, readbackTool, emailTool];
const registries = { snapshot: () => ({ tools: fixtureTools, rules: [], versions: { tools: "fixture-v1", rules: "fixture-v1" } }), hash: () => resolvedParameterHashBytes(canonicalJSONBytes(fixtureTools)),
  findTool: name => fixtureTools.find(value => [value.name, value.mcp_tool_name].includes(name)), enabledRules: () => [], findRule: () => undefined };
let repository, app, session, services, persistence;
const calls = [], reports = [], relatedInvoiceReports = [], relatedOrderReports = [], models = [], operations = [], readbacks = [], emails = [];
let sdkHook, modelHook;
const headers = (actor = "owner") => ({ authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { subject: actor, expiresIn: 3600 })}` });
async function waitFor(reader, label) {
  const deadline = performance.now() + 20_000;
  while (performance.now() < deadline) { const result = await reader(); if (result) return result; await delay(10); }
  throw new Error(`Synthetic runtime wait timed out: ${label}`);
}
async function start(repositoryValue) {
  repository = repositoryValue; persistence = repository.persistence;
  assert(persistence instanceof FirestoreRecordPersistence); assert.equal(persistence.readQueueDurability, "encrypted-single-writer"); assert.equal(persistence.executionCheckpointDurability, "encrypted-record-transactions/v1");
  const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
  session = await createErpbridgeMcpSession({ baseURL: config.erpbridgeBaseURL, token: config.erpbridgeMcpToken, timeoutMs: 10_000, validator,
    admissionAuthorizer: admissionAuthorizer(repository, registries), sdkClient: { metadataComplete: true, connect: async () => {}, close: async () => {},
      listTools: async () => fixtureTools.map(value => ({ name: exactBridgeName(value), inputSchema: bridgeTransportSchema(value), ...(value.bridge_contract.output_schema ? { outputSchema: value.bridge_contract.output_schema } : {}),
        _meta: { "toolplane.resourceVersion": "1.0.0", "toolplane.resourceDigest": value.bridge_contract.resource_digest, "io.erpbridge/allowedRoles": ["platform_admin"] } })),
      callTool: async (name, args, meta) => {
        assert.equal(args.role, "platform_admin");
        if (name === exactBridgeName(emailTool)) { assert.equal(meta["toolplane.resourceDigest"], "d".repeat(64));
          emails.push({ recipient: args.recipient, subject: args.subject, body: args.body }); return { content: [], structuredContent: { accepted: true, id: "synthetic-email-acceptance" } }; }
        if (name === exactBridgeName(operationTool)) { assert.equal(meta["toolplane.resourceDigest"], "b".repeat(64)); operations.push(args.id); return { content: [], structuredContent: { accepted: true, id: args.id } }; }
        if (name === exactBridgeName(readbackTool)) {
          assert.equal(meta["toolplane.resourceDigest"], "c".repeat(64)); readbacks.push(args.id);
          return { content: [], structuredContent: { id: args.id, state: operations.includes(args.id) ? "APPLIED" : "ABSENT", settled: true, observedAt: new Date().toISOString() } };
        }
        if (name === exactBridgeName(reportTool)) {
          assert.equal(meta["toolplane.resourceDigest"], "e".repeat(64)); const page = args.cursor === "" ? 1 : args.cursor === "cursor-firestore-2" ? 2 : 3, hasMore = page < 3;
          reports.push({ startAt: args.startAt, endAt: args.endAt, cursor: args.cursor });
          return { content: [], structuredContent: { coveredStartAt: args.startAt, coveredEndAt: args.endAt, complete: !hasMore, hasMore,
            items: [{ id: `invoice-firestore-${page}` }], itemCount: 1, reportId: "scheduled-operation", cursor: args.cursor,
            nextCursor: hasMore ? `cursor-firestore-${page + 1}` : "", snapshotId: "snapshot-firestore-daily", totalAvailable: 3 } };
        }
        if (name === exactBridgeName(relatedInvoiceTool)) {
          assert.equal(meta["toolplane.resourceDigest"], "f".repeat(64)); relatedInvoiceReports.push({ startAt: args.startAt, endAt: args.endAt });
          return { content: [], structuredContent: { coveredStartAt: args.startAt, coveredEndAt: args.endAt, complete: true, hasMore: false,
            items: [{ invoiceId: "invoice-related-1", orderId: "order-related-1" }, { invoiceId: "invoice-related-2", orderId: "order-related-2" }],
            itemCount: 2, orderIds: ["order-related-2", "order-related-1"], reportId: "related-report-operation" } };
        }
        if (name === exactBridgeName(relatedOrderTool)) {
          assert.equal(meta["toolplane.resourceDigest"], "1".repeat(64)); relatedOrderReports.push({ startAt: args.startAt, endAt: args.endAt, orderIds: structuredClone(args.orderIds) });
          const orderIds = [...args.orderIds].reverse();
          return { content: [], structuredContent: { coveredStartAt: args.startAt, coveredEndAt: args.endAt, complete: true, hasMore: false,
            items: orderIds.map((orderId, index) => ({ orderId, total: (index + 1) * 10 })), itemCount: orderIds.length, reportId: "related-report-operation" } };
        }
        assert.equal(name, exactBridgeName(tool)); assert.equal(meta["toolplane.resourceDigest"], "a".repeat(64));
        calls.push(args.id); await sdkHook?.(args); return { content: [], structuredContent: { id: args.id.toUpperCase(), token: "synthetic-remote-secret" } };
      } } });
  const providerRuntime = new ProviderRuntime(repository, executor, async (url, init) => {
    assert.equal(url, "https://provider.fixture.example.test/v1/chat/completions"); const request = JSON.parse(String(init.body)); models.push(request.model); await modelHook?.(request, init.signal);
    const node = request.messages[0].content.includes("ONE SELECTED NODE PATCH"), owner = request.messages[0].content.includes("ONE SELECTED COLLECTION PATCH"), answered = request.messages.some(message => message.role === "tool");
    if (owner) assert.deepEqual(JSON.parse(request.messages[1].content).tools, []);
    let candidateData = {};
    if (!node && !owner && !answered && typeof request.messages[1]?.content === "string" && request.messages[1].content.trim().startsWith("{"))
      try { candidateData = JSON.parse(request.messages[1].content); } catch { candidateData = {}; }
    const recurringContext = candidateData.SERVER_DERIVED_CONTEXT_JSON;
    if (recurringContext?.profile === "recurring-automation-candidate-context/v1") {
      const unresolved = recurringContext.required_unresolved_requirements.filter(value => !value.startsWith("Add exact reviewed ERP report") &&
        !value.startsWith("Add one exact reviewed ERP report") && !value.startsWith("Add one exact reviewed email"));
      const candidate = stringify({ name: "Daily invoice and related-order report", description: "Maps reviewed report contracts into one blocked recurring delivery draft.",
        trigger: { type: "manual", config: { inputSchema: { type: "object", properties: { reportStartAt: { type: "string" }, reportEndAt: { type: "string" } },
          required: ["reportStartAt", "reportEndAt"], additionalProperties: false } } }, steps: [
          { id: "invoice_report", action: relatedInvoiceTool.name, description: "Read complete invoices", parameters: { startAt: "{{input.reportStartAt}}", endAt: "{{input.reportEndAt}}" } },
          { id: "order_report", action: relatedOrderTool.name, description: "Read every related order", parameters: { startAt: "{{input.reportStartAt}}", endAt: "{{input.reportEndAt}}", orderIds: "{{invoice_report.structuredContent.orderIds}}" } },
          { id: "deliver_report", action: emailTool.name, description: "Propose reviewed email delivery", parameters: { recipient: "manager@example.test", subject: "Daily invoice and order report", body: "{{order_report.structuredContent.reportId}}" } },
        ], metadata: { automation_request: recurringContext.automation_request, unresolved_requirements: unresolved } });
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: candidate } }], usage: { prompt_tokens: 5, completion_tokens: 7 } });
    }
    return Response.json({ choices: [{ finish_reason: node || owner || answered ? "stop" : "tool_calls", message: owner ? { content: '{"maxItems":2}' } : node ? { content: '{"description":"Reviewable fixture edit"}' } : answered ? { content: "Confirmed fixture invoice CHAT." } : {
      content: "", tool_calls: [{ id: "fixture-chat-read", type: "function", function: { name: "read", arguments: '{"id":"chat"}' } }],
    } }], usage: { prompt_tokens: 5, completion_tokens: 7 } });
  });
  providerRuntime.activate({ id: "fixture-provider", name: "Fixture provider", type: "openai_compatible", baseURL: "https://provider.fixture.example.test/v1", apiKey: "synthetic-provider-secret", model: "fixture-model-a", additionalModels: ["fixture-model-b"], temperature: 0, timeoutMs: 10_000,
    egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://provider.fixture.example.test", runtimeAnalysisDataClasses: ["internal"],
      reviewedAt: "2026-10-07T00:00:00.000Z", reviewedBy: { id: "owner", name: "owner" } } });
  services = { config, repository, registries, validator, executor, providerRuntime, synthesis: new SynthesisService(providerRuntime, registries, validator), erpbridgeSession: session };
  app = await buildApp(services); await app.ready();
}
async function request(method, url, payload, status, actor = "owner") {
  const reply = await app.inject({ method, url, headers: headers(actor), ...(payload === undefined ? {} : { payload }) });
  assert.equal(reply.statusCode, status, reply.body); return reply.json();
}
async function stop() {
  try { await app?.close(); } finally { try { await session?.close(); } finally { await repository?.close(); app = session = undefined; } }
}

try {
  await start(await openApplicationRepository(config));
  const timestamp = new Date().toISOString();
  await repository.mutate(state => {
    for (const id of ["owner", "other"]) state.users[id] = { id, name: id, email: `${id}@example.test`, roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "F", departmentId: null, lastLoginAt: null, createdAt: timestamp };
    state.settings.unrelated = { text: "Preserved domain", private: "synthetic-domain-secret" };
    for (const [id, yaml] of [["single", sequential], ["collection", collection], ["collection_edit", collection]]) {
      state.workflows[id] = { id, name: id, description: "Synthetic fixture", owner: { id: "owner", name: "owner" }, assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 1, successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt: timestamp, updatedAt: timestamp, yaml, archived: false };
      state.versions[id] = [];
    }
  });
  const providerCreated = await request("POST", "/api/providers", { name: "Persisted fixture provider", type: "openai_compatible",
    baseUrl: "https://provider.fixture.example.test/v1", apiKey: "synthetic-provider-secret", model: "fixture-model-a", additionalModels: ["fixture-model-b"], temperature: 0,
    egressPolicy: { approvedOrigin: "https://provider.fixture.example.test", runtimeAnalysisDataClasses: ["internal"], confirmed: true } }, 201);
  const persistedProviderId = providerCreated.data.id;
  assert.deepEqual(providerCreated.data.egressPolicy.runtimeAnalysisDataClasses, ["internal"]);
  assert.equal(providerCreated.data.egressPolicy.approvedOrigin, "https://provider.fixture.example.test");
  assert(!JSON.stringify(providerCreated).includes("synthetic-provider-secret"));
  await request("POST", `/api/providers/${persistedProviderId}/activate`, {}, 200);
  log("actual Firestore provider administration stored an exact-origin reviewed internal-data egress policy without exposing the write-only credential");
  const actor = await repository.effectiveUser("owner"), observations = (await observeCapabilities({ repository, registries, session, user: actor })).observations;
  for (const observation of observations) await reviewCapability({ repository, registries, session, user: actor, capabilityId: observation.capabilityId, body: {
    observationId: observation.id, contractHash: observation.contractHash, decisionKey: "firestore-runtime-reviewed-fixture", effectClass: [operationTool.tool_id, emailTool.tool_id].includes(observation.toolId) ? "notification" : "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Synthetic SDK qualification only",
    ...([operationTool.tool_id, emailTool.tool_id].includes(observation.toolId) ? { requireIndependentApproval: true } : {}) } });
  for (const id of ["single", "collection"]) await request("POST", `/api/workflows/${id}/publish`, {}, 200);
  const ready = await request("GET", "/api/workflows/collection/readiness", undefined, 200); assert.equal(ready.data.can_attempt_run, true);
  const read = await request("POST", "/api/workflows/single/run", { input: { id: "single" } }, 200); assert.equal(read.data.status, "DONE"); assert.deepEqual(calls, ["single"]);
  const collectionRead = await request("POST", "/api/workflows/collection/run", { input: { rows: ["a", "b"] } }, 200);
  assert.equal(collectionRead.data.status, "DONE"); assert.deepEqual(collectionRead.data.finalOutput, ["A", "B"]); assert.deepEqual(calls, ["single", "a", "b"]);
  assert.equal(models.length, 0); log("actual Firestore application driver, reviewed publication/readiness and normal synchronous read/collection routes used exact fixture SDK calls, with zero model calls");

  const queuedPayload = { mode: "async-read", idempotencyKey: "firestore-runtime-queue-fixture-0001", input: { rows: ["queued-a", "queued-b"], private_token: "synthetic-private-input" } };
  const admitted = await request("POST", "/api/workflows/collection/run", queuedPayload, 202), queuedId = admitted.data.id;
  await waitFor(async () => { const state = await repository.snapshot(); return state.readJobs[queuedId]?.state === "FINISHED" && state.executions[queuedId]; }, "queued collection completion");
  const state = await repository.snapshot(); assert.deepEqual(state.executions[queuedId].finalOutput, ["QUEUED-A", "QUEUED-B"]); assert.equal(state.readJobs[queuedId].lease, undefined); assert.equal(state.readJobs[queuedId].inputCiphertext, undefined); assert.equal(state.readContinuations[queuedId], undefined);
  assert.equal((await request("POST", "/api/workflows/collection/run", queuedPayload, 202)).data.id, queuedId); assert.deepEqual(calls, ["single", "a", "b", "queued-a", "queued-b"]);
  const events = await request("GET", `/api/executions/${queuedId}/events?after=0&limit=100`, undefined, 200); assert(events.data.events.some(event => event.type === "iteration.action.completed"));
  assert(!JSON.stringify(events).includes("synthetic-private-input")); assert(!JSON.stringify(state.executions[queuedId]).includes("synthetic-remote-secret"));
  assert.deepEqual(state.settings.unrelated, { text: "Preserved domain", private: "synthetic-domain-secret" });
  log("normal queued collection, once-only admission, separately confirmed item answers, scoped event replay and terminal private-input/lease/cursor removal passed on actual Firestore");

  const chat = await request("POST", "/api/chat/sessions", {}, 201), chatId = chat.data.id;
  const chatPayload = { content: "Show me invoice details", model: "fixture-model-b", delivery: "async-chat", idempotencyKey: "firestore-runtime-chat-fixture-0001" };
  const chatReceipt = await request("POST", `/api/chat/sessions/${chatId}/messages`, chatPayload, 202), operationId = chatReceipt.data.operation.id;
  await waitFor(async () => { const op = (await repository.snapshot()).chatOperations[operationId]; return op && !["QUEUED", "RUNNING"].includes(op.status) && op; }, "chat answer");
  const operation = await request("GET", `/api/chat/operations/${operationId}?after=0`, undefined, 200);
  assert.equal(operation.data.operation.status, "ANSWERED"); assert.equal(operation.data.operation.attempts[0].status, "DONE"); assert.equal(operation.data.operation.attempts[0].output.structuredContent.id, "CHAT");
  assert.equal((await request("POST", `/api/chat/sessions/${chatId}/messages`, chatPayload, 202)).data.operation.id, operationId);
  assert.equal(calls.filter(id => id === "chat").length, 1); assert(models.every(model => model === "fixture-model-b"));
  assert(!JSON.stringify(operation).match(/synthetic-provider-secret|synthetic-remote-secret|inputCiphertext/));
  await request("GET", `/api/chat/operations/${operationId}`, undefined, 404, "other");
  const nodePayload = { content: "Edit this selected node", model: "fixture-model-b", delivery: "async-chat", idempotencyKey: "firestore-runtime-node-fixture-0001",
    nodeContext: { workflowId: "single", nodeId: "lookup", baseVersion: 1, baseHash: workflowContentHash(sequential) } };
  const callsBeforeNode = calls.length, nodeReceipt = await request("POST", `/api/chat/sessions/${chatId}/messages`, nodePayload, 202), nodeOperation = nodeReceipt.data.operation.id;
  await waitFor(async () => { const op = (await repository.snapshot()).chatOperations[nodeOperation]; return op && !["QUEUED", "RUNNING"].includes(op.status) && op; }, "selected node proposal");
  assert.equal((await repository.snapshot()).chatOperations[nodeOperation].status, "ANSWERED"); assert.equal(calls.length, callsBeforeNode); assert.equal((await repository.snapshot()).workflows.single.yaml, sequential);
  log("normal saved chat job used its selected model, committed one redacted SDK answer and enforced operation ACL/idempotency; selected-node chat saved a reviewable proposal without applying or dispatching");

  const ownerPayload = { content: "Limit this selected collection to two items", model: "fixture-model-b", delivery: "async-chat", idempotencyKey: "firestore-runtime-owner-fixture-0001",
    nodeContext: { workflowId: "collection_edit", nodeId: "each", baseVersion: 1, baseHash: workflowContentHash(collection) } };
  const modelsBeforeOwner = models.length, ownerOperation = (await request("POST", `/api/chat/sessions/${chatId}/messages`, ownerPayload, 202)).data.operation.id;
  await waitFor(async () => { const op = (await repository.snapshot()).chatOperations[ownerOperation]; return op && !["QUEUED", "RUNNING"].includes(op.status) && op; }, "collection owner proposal");
  const ownerState = await repository.snapshot(), ownerProposal = ownerState.chats[chatId].messages.at(-1).artifacts.proposal;
  assert.equal(ownerState.chatOperations[ownerOperation].status, "ANSWERED"); assert.deepEqual(ownerState.chatOperations[ownerOperation].attempts, []);
  assert.deepEqual(ownerProposal.command, { type: "updateCollection", nodeId: "each", patch: { maxItems: 2 } }); assert.equal(ownerProposal.validation.passed, true);
  assert.equal(ownerState.workflows.collection_edit.yaml, collection); assert.equal(models.length, modelsBeforeOwner + 1); assert.equal(calls.length, callsBeforeNode);
  assert.equal((await request("POST", `/api/chat/sessions/${chatId}/messages`, ownerPayload, 202)).data.operation.id, ownerOperation); assert.equal(models.length, modelsBeforeOwner + 1);
  await request("GET", `/api/chat/operations/${ownerOperation}`, undefined, 404, "other");
  const applyPayload = { baseVersion: 1, baseHash: workflowContentHash(collection), proposalId: ownerProposal.id, command: ownerProposal.command };
  const applied = (await request("POST", "/api/workflows/collection_edit/commands", applyPayload, 200)).data;
  assert.equal(applied.version, 2); assert.equal(applied.canRun, false); assert.equal(applied.publishedVersion, 0);
  const originalSource = parseWorkflowYAMLStrict(collection), editedSource = parseWorkflowYAMLStrict(applied.yaml);
  assert.deepEqual(editedSource.steps, originalSource.steps); assert.deepEqual(editedSource.metadata.controlFlow.root.nodes[0], { ...originalSource.metadata.controlFlow.root.nodes[0], maxItems: 2 });
  await request("POST", "/api/workflows/collection_edit/commands", applyPayload, 409);
  assert.equal((await repository.snapshot()).chats[chatId].messages.at(-1).artifacts.proposal.status, "APPLIED"); assert.equal(calls.length, callsBeforeNode);
  log("collection-owner saved chat used its dedicated tools-free patch contract and selected model; exact explicit once-only draft apply preserved body/actions and never published or dispatched");

  const callsBeforeAutomation = calls.length, modelsBeforeAutomation = models.length;
  const automation = (await request("POST", `/api/chat/sessions/${chatId}/messages`, { content: "Send daily invoice and order details to manager@example.test" }, 200)).data.assistantMessage.artifacts;
  assert.equal(automation.intent, "WORKFLOW"); assert.equal(automation.automationRequest.profile, "recurring-delivery-request/v1");
  assert.equal(automation.automationRequest.cadence, "daily"); assert.equal(automation.automationRequest.scheduleActive, false); assert(automation.workflowId);
  assert.deepEqual(automation.automationRequest.requestedResources, ["invoices", "orders"]); assert.equal(automation.automationComposition.status, "CAPABILITIES_MAPPED");
  assert.equal(automation.automationComposition.mappedSteps.length, 3); assert.deepEqual(automation.automationComposition.relatedRecords, { status: "MATCHED", relationName: "invoice-orders" });
  assert.equal(automation.automationComposition.readyForPublication, false); assert.equal(automation.automationComposition.scheduleActive, false); assert.equal(automation.emailDraft, undefined);
  const automationWorkflow = (await repository.snapshot()).workflows[automation.workflowId];
  assert.equal(automationWorkflow.publishedVersion, 0); assert.equal(automationWorkflow.steps, 3); assert.equal(automationWorkflow.canRun, false); assert.equal(automationWorkflow.trigger.type, "manual");
  assert.match(automationWorkflow.yaml, /unresolved_requirements/); assert.equal((await repository.snapshot()).schedules[`schedule-${automation.workflowId}`], undefined);
  assert.equal(calls.length, callsBeforeAutomation); assert.equal(models.length, modelsBeforeAutomation + 1); assert.equal(emails.length, 0); assert.equal(operations.length, 0);
  const modelsAfterAutomation = models.length;
  log("recurring delivery wording used one model proposal to save exact reviewed invoice, related-order and delivery capability steps with readable remaining gates, zero SDK calls and no active schedule or one-off email draft");

  const saved = await repository.snapshot(); await stop(); await start(await openApplicationRepository(config));
  assert.deepEqual((await repository.snapshot()).chats, saved.chats); assert.deepEqual((await repository.snapshot()).executions, saved.executions);
  assert.deepEqual((await repository.snapshot()).versions, saved.versions); assert.equal((await request("GET", `/api/chat/operations/${operationId}`, undefined, 200)).data.operation.status, "ANSWERED");
  assert.deepEqual((await repository.snapshot()).workflows.collection_edit, saved.workflows.collection_edit);
  assert.equal((await repository.snapshot()).chats[chatId].messages.findLast(message => message.artifacts?.proposal)?.artifacts.proposal.status, "APPLIED");
  assert.deepEqual((await repository.snapshot()).workflows[automation.workflowId], automationWorkflow); assert.equal((await repository.snapshot()).schedules[`schedule-${automation.workflowId}`], undefined);
  assert.deepEqual((await repository.snapshot()).providers[persistedProviderId].egressPolicy.runtimeAnalysisDataClasses, ["internal"]);
  assert.equal((await repository.snapshot()).providers[persistedProviderId].egressPolicy.approvedOrigin, "https://provider.fixture.example.test");
  assert.equal(calls.length, callsBeforeNode); log("fresh application repository/HTTP worker startup preserved chats, proposals, versions and confirmed runs without replay");

  const historyReady = (await request("GET", "/api/workflows/collection_edit/readiness", undefined, 200)).data;
  assert.equal(historyReady.editHistory.undoDepth, 1); assert.equal(historyReady.editHistory.redoDepth, 0);
  const undoPayload = { baseVersion: historyReady.version, baseHash: historyReady.contentHash, command: { type: "undoDraft", versionId: historyReady.editHistory.undoTarget } };
  const undone = (await request("POST", "/api/workflows/collection_edit/commands", undoPayload, 200)).data;
  assert.equal(undone.version, 3); assert.equal(undone.yaml, collection); assert.equal(undone.canRun, false); assert.equal(undone.publishedVersion, 0); assert.equal(undone.editHistory.redoDepth, 1);
  await request("POST", "/api/workflows/collection_edit/commands", undoPayload, 409);
  const historyAfterUndo = await repository.snapshot(); await stop(); await start(await openApplicationRepository(config));
  assert.deepEqual((await repository.snapshot()).versions, historyAfterUndo.versions);
  const reopened = (await request("GET", "/api/workflows/collection_edit/readiness", undefined, 200)).data;
  assert.deepEqual(reopened.editHistory, undone.editHistory);
  const redone = (await request("POST", "/api/workflows/collection_edit/commands", { baseVersion: reopened.version, baseHash: reopened.contentHash, command: { type: "redoDraft", versionId: reopened.editHistory.redoTarget } }, 200)).data;
  assert.equal(redone.version, 4); assert.equal(redone.yaml, applied.yaml); assert.equal(redone.canRun, false); assert.equal(redone.publishedVersion, 0);
  const historyQuery = `view=edit-history&baseVersion=${redone.version}&baseHash=${redone.contentHash}`;
  const history = (await request("GET", `/api/workflows/collection_edit/versions?${historyQuery}`, undefined, 200)).data;
  assert.equal(history.total, 4); assert.equal(history.entries[0].change.type, "redoDraft"); assert(!JSON.stringify(history).includes('"yaml"'));
  assert.equal(calls.length, callsBeforeNode); assert.equal(models.length, modelsAfterAutomation);
  assert.equal((await repository.snapshot()).chats[chatId].messages.findLast(message => message.artifacts?.proposal)?.artifacts.proposal.appliedVersion, 2);
  log("normal Firestore saved-history HTTP undo/restart/redo preserved exact collection content, immutable revisions and historical proposal provenance without publication, SDK dispatch or model calls");

  // Losing an edit's COMMIT acknowledgement must not be reported as "nothing
  // changed": the durable revision may exist while the old cache is fenced.
  const actualHistoryTransaction = persistence.records.db.runTransaction.bind(persistence.records.db); let lostHistoryAck = false;
  persistence.records.db.runTransaction = async (callback, options) => {
    let activated = false;
    const value = await actualHistoryTransaction(async transaction => {
      const set = transaction.set; transaction.set = function (ref, ...args) { if (ref.path === persistence.records.headPath) activated = true; return set.call(this, ref, ...args); };
      try { return await callback(transaction); } finally { transaction.set = set; }
    }, options);
    if (activated && !lostHistoryAck) { lostHistoryAck = true; throw new Error("Synthetic saved-history post-COMMIT acknowledgement lost"); }
    return value;
  };
  const uncertainUndo = { baseVersion: redone.version, baseHash: redone.contentHash, command: { type: "undoDraft", versionId: redone.editHistory.undoTarget } };
  const uncertainEdit = await request("POST", "/api/workflows/collection_edit/commands", uncertainUndo, 503);
  assert(lostHistoryAck); assert.equal(uncertainEdit.meta.code, "DRAFT_SAVE_UNCONFIRMED"); assert(!uncertainEdit.message.includes("nothing was changed"));
  persistence.records.db.runTransaction = actualHistoryTransaction;
  await repository.recoverPersistenceState();
  const reconciledHistory = (await request("GET", "/api/workflows/collection_edit/readiness", undefined, 200)).data;
  assert.equal(reconciledHistory.version, 5); assert.equal(reconciledHistory.yaml, collection); assert.equal(reconciledHistory.editHistory.redoDepth, 1);
  await request("POST", "/api/workflows/collection_edit/commands", uncertainUndo, 409);
  assert.equal(calls.length, callsBeforeNode); assert.equal(models.length, modelsAfterAutomation);
  // Storage reconciliation does not silently revive stopped dispatch workers.
  // A fresh supervised application instance is required by this runtime.
  await request("POST", "/api/workflows/collection/run", { mode: "async-read", idempotencyKey: "firestore-history-fenced-queue-0001", input: { rows: ["must-not-enter"] } }, 503);
  await stop(); await start(await openApplicationRepository(config));
  assert.equal((await repository.snapshot()).workflows.collection_edit.draftVersion, 5); assert(!calls.includes("must-not-enter"));
  log("actual post-COMMIT edit acknowledgement loss reported an unconfirmed outcome, fenced the old cache and reconciled one saved draft; repeated stale undo did not create another revision or execute anything");

  const canvasOriginal = (await request("GET", "/api/workflows/collection_edit/readiness", undefined, 200)).data;
  const beforeCanvasVersions = (await repository.snapshot()).versions.collection_edit;
  // Deliberately move the collection after its dependent return: source and
  // bindings are preserved, but current compilation must block execution.
  const canvasMoved = (await request("POST", "/api/workflows/collection_edit/commands", { baseVersion: canvasOriginal.version, baseHash: canvasOriginal.contentHash,
    command: { type: "moveNode", nodeId: "each", beforeNodeId: null } }, 200)).data;
  assert.equal(canvasMoved.version, 6); assert.equal(canvasMoved.canRun, false); assert.equal(canvasMoved.validation.passed, false);
  const movedSource = parseWorkflowYAMLStrict(canvasMoved.yaml), originalCanvasSource = parseWorkflowYAMLStrict(canvasOriginal.yaml);
  assert.deepEqual(movedSource.steps, originalCanvasSource.steps);
  assert.deepEqual(movedSource.metadata.controlFlow.root.nodes, [originalCanvasSource.metadata.controlFlow.root.nodes[1], originalCanvasSource.metadata.controlFlow.root.nodes[0]]);
  assert.deepEqual((await repository.snapshot()).versions.collection_edit.slice(0, beforeCanvasVersions.length), beforeCanvasVersions);
  await request("POST", "/api/workflows/collection_edit/commands", { baseVersion: canvasMoved.version, baseHash: canvasMoved.contentHash,
    command: { type: "moveNode", nodeId: "each", beforeNodeId: "lookup", destination: { loopId: "each", scope: "body" } } }, 422);
  await stop(); await start(await openApplicationRepository(config));
  const reopenedCanvas = (await request("GET", "/api/workflows/collection_edit/readiness", undefined, 200)).data;
  assert.equal(reopenedCanvas.yaml, canvasMoved.yaml); assert.equal(reopenedCanvas.can_attempt_run, false); assert.equal(reopenedCanvas.validation.passed, false);
  const canvasUndo = (await request("POST", "/api/workflows/collection_edit/commands", { baseVersion: reopenedCanvas.version, baseHash: reopenedCanvas.contentHash,
    command: { type: "undoDraft", versionId: reopenedCanvas.editHistory.undoTarget } }, 200)).data;
  assert.equal(canvasUndo.version, 7); assert.equal(canvasUndo.yaml, canvasOriginal.yaml);
  assert.equal(calls.length, callsBeforeNode); assert.equal(models.length, modelsAfterAutomation); assert.equal(canvasUndo.publishedVersion, 0);
  log("normal Firestore whole-collection canvas move retained body/configuration and broken references as a blocked saved draft; restart and explicit undo preserved exact original content without publication, SDK or model calls");

  // Server-only synthetic checkpoint producer, NOT a real effect executor.
  // Decision/review/configuration requests use the ordinary authenticated API.
  const callsBeforeApproval = calls.length, modelsBeforeApproval = models.length;
  const approvalRunId = `approval_${randomUUID()}`, approvalAttemptId = `attempt_${randomUUID()}`;
  await repository.mutate(state => {
    state.roles.approval_fixture = { id: "approval_fixture", name: "Fixture approver", description: "Review only", permissions: ["execution:approve"], createdAt: new Date().toISOString() };
    state.users.reviewer = { ...state.users.owner, id: "reviewer", name: "reviewer", email: "reviewer@example.test", roleId: "approval_fixture" };
    const original = structuredClone(state.executions[read.data.id]);
    state.executions[approvalRunId] = { ...original, id: approvalRunId, status: "RUNNING", completedAt: null, failure: undefined, stepOutputs: {}, finalOutput: undefined,
      agentSummary: undefined, workflowSnapshot: { ...original.workflowSnapshot, input: { id: "approval-fixture" } }, readProgress: newReadProgress(repository) };
    state.executions[approvalRunId].readProgress.attempts.lookup = { id: approvalAttemptId, nodeId: "lookup", stepIndex: 0, status: "PREPARING", startedAt: new Date().toISOString() };
  });
  await request("PATCH", "/api/settings/rbac", { enabled: false, runtimeApprovalPolicy: { profile: "runtime-approval-policy/v1", baseRevision: 0, enabled: true,
    approverRoleIds: ["approval_fixture"], ttlSeconds: 300, separationOfDuties: true } }, 200);
  const approvalBinding = await repository.readAuthoritative(state => {
    const compilation = state.executions[approvalRunId].workflowSnapshot.compilation, node = state.versions.single.findLast(item => item.artifactState === "PUBLISHED").compiledRead.plan.ir.root.nodes[0];
    const pin = node.capability.admission, revision = state.capabilityRevisions[pin.revisionId];
    return { executionId: approvalRunId, workflowId: "single", nodeId: "lookup", invocationId: approvalAttemptId, operationKey: `operation_${randomUUID()}`,
      sourceHash: compilation.sourceHash, semanticHash: compilation.semanticHash, connectionId: pin.connectionId, connectionBinding: revision.connectionBinding, capabilityId: pin.capabilityId,
      capabilityRevision: pin.revisionId, admissionVersion: pin.admissionVersion, contractHash: pin.contractHash, argumentHash: resolvedParameterHashBytes(canonicalJSONBytes({ id: "approval-fixture" })),
      requesterId: "owner", requesterRoleId: "role_admin", workerEpoch: 1, policyHash: runtimeApprovalPolicyHash(state) };
  });
  await requestRuntimeApproval(repository, approvalRunId, approvalBinding, { id: "approval-fixture" }, "Review exact synthetic read checkpoint; no effect executor");
  const approvalView = (await request("GET", `/api/executions/${approvalRunId}?view=approval`, undefined, 200, "reviewer")).data.runtimeApproval;
  assert.deepEqual(approvalView.arguments, { id: "approval-fixture" }); assert.equal(approvalView.canDecide, true); assert.equal(approvalView.canResume, false);
  assert.equal(approvalView.toolName, tool.name); assert.equal(approvalView.remoteToolName, exactBridgeName(tool));
  await request("GET", `/api/executions/${approvalRunId}`, undefined, 404, "reviewer"); await request("GET", `/api/executions/${approvalRunId}/logs`, undefined, 403, "reviewer");
  const approvalCommand = { approvalId: approvalView.id, baseVersion: approvalView.version, reviewHash: approvalView.reviewHash, decisionKey: "firestore-exact-approval-fixture-0001", note: "Synthetic independent review" };
  await request("POST", `/api/executions/${approvalRunId}/approve`, approvalCommand, 403, "owner");
  const approvalTransaction = persistence.records.db.runTransaction.bind(persistence.records.db); let loseApprovalACK = true;
  persistence.records.db.runTransaction = async (callback, options) => { const result = await approvalTransaction(callback, options); if (loseApprovalACK) { loseApprovalACK = false; throw new Error("Synthetic approval post-COMMIT ACK lost"); } return result; };
  try { await request("POST", `/api/executions/${approvalRunId}/approve`, approvalCommand, 503, "reviewer"); } finally { persistence.records.db.runTransaction = approvalTransaction; }
  const fencedReview = await app.inject({ method: "GET", url: `/api/executions/${approvalRunId}?view=approval`, headers: headers("reviewer") }); assert(fencedReview.statusCode >= 400);
  await repository.recoverPersistenceState();
  const approvedReview = (await request("GET", `/api/executions/${approvalRunId}?view=approval`, undefined, 200, "reviewer")).data;
  assert.equal(approvedReview.status, "BLOCKED"); assert.equal(approvedReview.runtimeApproval.state, "APPROVED"); assert.equal(approvedReview.runtimeApproval.canDecide, false);
  const approvalEvents = (await repository.snapshot()).executionEvents[approvalRunId].length;
  assert.equal((await request("POST", `/api/executions/${approvalRunId}/approve`, approvalCommand, 200, "reviewer")).data.replayed, true);
  assert.equal((await repository.snapshot()).executionEvents[approvalRunId].length, approvalEvents);
  await stop(); await start(await openApplicationRepository(config));
  assert.equal((await request("GET", `/api/executions/${approvalRunId}?view=approval`, undefined, 200, "reviewer")).data.runtimeApproval.state, "APPROVED");
  await repository.mutateExecution(approvalRunId, state => consumeRuntimeApproval(state, approvalRunId, approvalBinding, { id: "approval-fixture" }, "fixture-dispatch-intent-not-an-outbox"));
  await assert.rejects(repository.mutateExecution(approvalRunId, state => consumeRuntimeApproval(state, approvalRunId, approvalBinding, { id: "approval-fixture" }, "second-intent")));
  assert.equal(calls.length, callsBeforeApproval); assert.equal(models.length, modelsBeforeApproval);
  log("actual Firestore exact approval review/decision POST-COMMIT ACK loss, authoritative reconciliation, original-key replay, fresh restart and once-only private consumption preserved immutable review; zero additional SDK/model calls and no effect resume");

  const operationYAML = stringify({ name: "Synthetic approved notification", description: "Actual Firestore plus in-process synthetic operation only", trigger: { type: "manual" }, steps: [
    { id: "lookup", action: "read", parameters: { id: "{{input.id}}" } }, { id: "send", action: operationTool.name, parameters: { id: "{{lookup.structuredContent.id}}" } },
  ] });
  await repository.mutate(state => { state.workflows.operation = { ...state.workflows.single, id: "operation", name: "Synthetic approved notification", yaml: operationYAML, steps: 2, publishedVersion: 0, draftVersion: 1, canRun: false }; state.versions.operation = []; });
  const operationPublication = (await request("POST", "/api/workflows/operation/publish", {}, 200)).data;
  assert.equal(operationPublication.executionReadiness, "COMPILED_OPERATION");
  assert.equal((await request("GET", "/api/workflows/operation/readiness", undefined, 200)).data.can_attempt_run, true);
  const publishedOperation = (await repository.snapshot()).versions.operation.at(-1), readbackBinding = publishedOperation.compiledOperation.plan.ir.root.nodes[1].readback;
  assert.equal(readbackBinding.profile, "operation-readback-binding/v1"); assert.equal(readbackBinding.toolId, readbackTool.tool_id);
  assert.equal(readbackBinding.contractHash, capabilityContractHash(readbackTool));
  assert.equal(publishedOperation.compiledOperation.plan.ir.root.nodes.length, 2); assert.equal(readbacks.length, 0);
  const modelsBeforeOperation = models.length;
  const operationRun = (await request("POST", "/api/workflows/operation/run", { mode: "async-operation", idempotencyKey: "firestore-operation-normal-0001", input: { id: "operation-fixture-one" } }, 202)).data.id;
  await waitFor(async () => (await repository.snapshot()).executions[operationRun].status === "AWAITING_APPROVAL", "normal operation approval producer");
  assert.equal(operations.length, 0); const waitingOperation = (await repository.snapshot()).executions[operationRun];
  assert.equal(waitingOperation.operationSecret.state, "WAITING"); assert.equal(waitingOperation.operationSecret.lease, undefined);
  await stop(); await start(await openApplicationRepository(config));
  assert.deepEqual((await repository.snapshot()).executions[operationRun], waitingOperation); assert.equal(operations.length, 0);
  assert.deepEqual((await repository.snapshot()).versions.operation.at(-1).compiledOperation.plan.ir.root.nodes[1].readback, readbackBinding);
  const operationReview = (await request("GET", `/api/executions/${operationRun}?view=approval`, undefined, 200, "reviewer")).data.runtimeApproval;
  const waitingInbox = (await request("GET", "/api/execution-reviews?kind=approval&limit=5", undefined, 200, "reviewer")).data;
  assert(waitingInbox.items.some(item => item.executionId === operationRun && item.actionable && item.statusLabel === "Awaiting decision"));
  assert(!JSON.stringify(waitingInbox).includes('"arguments":')); assert(!JSON.stringify(waitingInbox).includes("OPERATION-FIXTURE-ONE"));
  assert(!(await request("GET", "/api/execution-reviews?kind=approval", undefined, 200)).data.items.some(item => item.executionId === operationRun));
  assert.equal(operations.length, 0); assert.equal(models.length, modelsBeforeOperation);
  assert.deepEqual(operationReview.arguments, { id: "OPERATION-FIXTURE-ONE" }); assert.equal(operationReview.operationManaged, true);
  const operationCommand = { approvalId: operationReview.id, baseVersion: operationReview.version, reviewHash: operationReview.reviewHash, decisionKey: "firestore-operation-decision-0001" };
  assert.equal((await request("POST", `/api/executions/${operationRun}/approve`, operationCommand, 200, "reviewer")).data.resumeQueued, true);
  await waitFor(async () => (await repository.snapshot()).executions[operationRun].status === "DONE", "approved operation result checkpoint");
  assert.deepEqual(operations, ["OPERATION-FIXTURE-ONE"]); assert.equal(models.length, modelsBeforeOperation);
  const completedOperation = (await repository.snapshot()).executions[operationRun]; assert.equal(completedOperation.operationSecret.intents.send.state, "ACKNOWLEDGED");
  assert.equal(completedOperation.operationSecret.intents.send.evidenceMeaning, "operation-accepted"); assert.equal(completedOperation.runtimeApprovalSecret.records[operationReview.id].state, "CONSUMED");
  assert.equal(JSON.stringify((await request("GET", `/api/executions/${operationRun}`, undefined, 200)).data).includes("operationSecret"), false);
  assert.equal((await request("POST", `/api/executions/${operationRun}/approve`, operationCommand, 200, "reviewer")).data.replayed, true);
  await stop(); await start(await openApplicationRepository(config)); assert.deepEqual((await repository.snapshot()).executions[operationRun], completedOperation); assert.equal(operations.length, 1);
  const approvalHistoryInbox = (await request("GET", "/api/execution-reviews?kind=approval&state=closed", undefined, 200, "reviewer")).data;
  assert(approvalHistoryInbox.items.some(item => item.executionId === operationRun && !item.actionable && item.statusLabel === "Approved — not delivery confirmation"));
  const savedReviewEntry = approvalHistoryInbox.items.find(item => item.executionId === operationRun);
  assert.equal(savedReviewEntry.reviewId, operationReview.id);
  const historicalApproval = (await request("GET", `/api/executions/${operationRun}?view=approval&approvalId=${encodeURIComponent(savedReviewEntry.reviewId)}`, undefined, 200, "reviewer")).data.runtimeApproval;
  assert.equal(historicalApproval.id, operationReview.id); assert.equal(historicalApproval.state, "CONSUMED"); assert.equal(historicalApproval.canDecide, false);
  log("actual Firestore normal operation publication/run produced a durable exact approval wait, survived restart without calls, then consumed independent approval and acknowledged one synthetic SDK result; zero model calls and no duplicate after decision replay/restart");

  const modelsBeforeEmail = models.length, operationsBeforeEmail = operations.length, emailChat = await request("POST", "/api/chat/sessions", { title: "Exact email review" }, 201);
  const emailPrepared = (await request("POST", `/api/chat/sessions/${emailChat.data.id}/messages`, { content: "Email manager@example.test" }, 200)).data.assistantMessage.artifacts.emailDraft;
  const emailSaved = (await request("POST", `/api/chat/sessions/${emailChat.data.id}/messages`, { emailDraftCommand: { draftId: emailPrepared.id, baseVersion: emailPrepared.version,
    baseHash: emailPrepared.contentHash, commandId: "firestore-email-edit-0001", patch: { to: "manager@example.test", subject: "Reviewed invoice summary", body: "Exact reviewed Firestore fixture body." } } }, 200)).data.assistantMessage.artifacts.emailDraft;
  const emailAdmissionCommand = { profile: "email-delivery-admission-command/v1", draftId: emailSaved.id, baseVersion: emailSaved.version,
    baseHash: emailSaved.contentHash, idempotencyKey: "firestore-email-admission-0001", sharingConfirmed: true };
  const actualEmailAdmissionSave = persistence.save.bind(persistence); let lostEmailAdmissionACK = false;
  persistence.save = async payload => { await actualEmailAdmissionSave(payload); if (!lostEmailAdmissionACK) {
    lostEmailAdmissionACK = true; throw new Error("Synthetic actual Firestore email-admission post-COMMIT acknowledgement loss");
  } };
  await request("POST", `/api/chat/sessions/${emailChat.data.id}/messages`, { emailDeliveryCommand: emailAdmissionCommand }, 503); assert.equal(lostEmailAdmissionACK, true);
  persistence.save = actualEmailAdmissionSave; await stop(); await start(await openApplicationRepository(config));
  const emailAdmission = Object.values((await repository.snapshot()).emailDeliveryAdmissions)[0]; assert(emailAdmission);
  await waitFor(async () => (await repository.snapshot()).executions[emailAdmission.executionId].status === "AWAITING_APPROVAL", "email draft independent approval wait");
  assert.deepEqual(emails, []); assert.equal(operations.length, operationsBeforeEmail); assert.equal(models.length, modelsBeforeEmail);
  const emailReview = (await request("GET", `/api/executions/${emailAdmission.executionId}?view=approval`, undefined, 200, "reviewer")).data.runtimeApproval;
  assert.deepEqual(emailReview.arguments, { recipient: "manager@example.test", subject: "Reviewed invoice summary", body: "Exact reviewed Firestore fixture body." });
  await request("POST", `/api/executions/${emailAdmission.executionId}/approve`, { approvalId: emailReview.id, baseVersion: emailReview.version,
    reviewHash: emailReview.reviewHash, decisionKey: "firestore-email-approval-0001" }, 200, "reviewer");
  await waitFor(async () => (await repository.snapshot()).executions[emailAdmission.executionId].status === "DONE", "approved exact email notification acceptance");
  assert.deepEqual(emails, [{ recipient: "manager@example.test", subject: "Reviewed invoice summary", body: "Exact reviewed Firestore fixture body." }]);
  const replayedEmail = (await request("POST", `/api/chat/sessions/${emailChat.data.id}/messages`, { emailDeliveryCommand: emailAdmissionCommand }, 202)).data.emailDelivery;
  assert.equal(replayedEmail.executionId, emailAdmission.executionId); assert.equal(replayedEmail.replayed, true); assert.equal(replayedEmail.bridgeDispatched, true); assert.equal(replayedEmail.deliveryVerified, false);
  const reloadedEmailChat = (await request("GET", `/api/chat/sessions/${emailChat.data.id}`, undefined, 200)).data;
  const latestEmailArtifact = reloadedEmailChat.messages.findLast(message => message.artifacts?.emailDelivery)?.artifacts.emailDelivery;
  assert.equal(latestEmailArtifact.status, "DONE"); assert.equal(latestEmailArtifact.bridgeDispatched, true); assert.equal(latestEmailArtifact.deliveryVerified, false);
  await request("POST", `/api/workflows/${emailAdmission.workflowId}/run`, { mode: "async-operation", idempotencyKey: "firestore-email-direct-rerun-0001", input: {} }, 409);
  await request("GET", `/api/workflows/${emailAdmission.workflowId}`, undefined, 404, "other");
  await request("GET", `/api/workflows/${emailAdmission.workflowId}/yaml`, undefined, 404, "other");
  await request("GET", `/api/executions/${emailAdmission.executionId}`, undefined, 404, "other");
  await request("PATCH", `/api/workflows/${emailAdmission.workflowId}`, { name: "Forbidden mutation" }, 409);
  await request("POST", `/api/workflows/${emailAdmission.workflowId}/duplicate`, {}, 409);
  await request("DELETE", `/api/workflows/${emailAdmission.workflowId}`, undefined, 409);
  await request("DELETE", `/api/chat/sessions/${emailChat.data.id}`, undefined, 409);
  const linkedEmailWorkflow = (await repository.snapshot()).workflows[emailAdmission.workflowId];
  await request("PUT", `/api/workflows/${emailAdmission.workflowId}/schedule`, { profile: "workflow-daily-schedule-command/v1", baseRevision: 0,
    workflowVersion: linkedEmailWorkflow.publishedVersion, workflowHash: workflowContentHash(linkedEmailWorkflow.yaml), enabled: true, timezone: "UTC", localTime: "09:00",
    reportingPeriod: "previous-calendar-day", misfirePolicy: "SKIP", misfireGraceSeconds: 300, servicePrincipalId: "owner", input: {},
    reportWindowBinding: { profile: "workflow-report-window-input-binding/v1", startAtInput: "reportStartAt", endAtInput: "reportEndAt" } }, 409);
  await stop(); await start(await openApplicationRepository(config)); assert.equal(Object.values((await repository.snapshot()).emailDeliveryAdmissions).length, 1);
  assert.equal(Object.values((await repository.snapshot()).executions).filter(value => value.emailDeliverySource?.admissionId === emailAdmission.id).length, 1);
  assert.equal(emails.length, 1); assert.equal(operations.length, operationsBeforeEmail); assert.equal(models.length, modelsBeforeEmail);
  log("actual Firestore exact email-draft admission survived post-COMMIT acknowledgement loss as one immutable linked execution, required fresh independent approval, dispatched only server-derived fields once, and retained acceptance-not-delivery truth on replay/restart");

  const scheduledOperationYAML = stringify({ name: "Scheduled synthetic report", description: "Server-bound report window fixture", trigger: { type: "manual", config: { inputSchema: {
    type: "object", properties: { reportStartAt: { type: "string" }, reportEndAt: { type: "string" } },
    required: ["reportStartAt", "reportEndAt"], additionalProperties: false } } }, steps: [
    { id: "report", action: reportTool.name, parameters: { startAt: "{{input.reportStartAt}}", endAt: "{{input.reportEndAt}}" } },
    { id: "send", action: operationTool.name, parameters: { id: "{{report.structuredContent.reportId}}" } },
  ] });
  await repository.mutate(state => { state.workflows.scheduledOperation = { ...state.workflows.operation, id: "scheduledOperation", name: "Scheduled synthetic report",
    yaml: scheduledOperationYAML, steps: 2, publishedVersion: 0, draftVersion: 1, canRun: false }; state.versions.scheduledOperation = []; });
  await request("POST", "/api/workflows/scheduledOperation/publish", {}, 200);
  const scheduleWorkflow = (await repository.snapshot()).workflows.scheduledOperation;
  const scheduleLocalTime = new Date(Date.now() + 120_000).toISOString().slice(11, 16);
  const reportWindowBinding = { profile: "workflow-report-window-input-binding/v1", startAtInput: "reportStartAt", endAtInput: "reportEndAt" };
  const schedule = (await request("PUT", "/api/workflows/scheduledOperation/schedule", { profile: "workflow-daily-schedule-command/v1", baseRevision: 0,
    workflowVersion: scheduleWorkflow.publishedVersion, workflowHash: workflowContentHash(scheduleWorkflow.yaml), enabled: true, timezone: "UTC",
    localTime: scheduleLocalTime, reportingPeriod: "previous-calendar-day", misfirePolicy: "FIRE_ONCE", misfireGraceSeconds: 300,
    servicePrincipalId: "owner", input: {}, reportWindowBinding }, 200)).data;
  const scheduledFor = schedule.nextRunAt, operationsBeforeSchedule = operations.length, modelsBeforeSchedule = models.length;
  const actualScheduleClaimSave = persistence.save.bind(persistence); let lostScheduleClaimACK = false;
  persistence.save = async payload => { await actualScheduleClaimSave(payload); if (!lostScheduleClaimACK) {
    lostScheduleClaimACK = true; throw new Error("Synthetic actual Firestore schedule-claim post-COMMIT acknowledgement loss");
  } };
  await assert.rejects(workflowScheduleRunner(services).runDue(Date.parse(scheduledFor)), /schedule-claim post-COMMIT/);
  assert.equal(lostScheduleClaimACK, true); persistence.save = actualScheduleClaimSave;
  await stop();
  const pageRepository = await openApplicationRepository(config), pagePersistence = pageRepository.persistence;
  const actualPageCheckpoint = pagePersistence.saveExecutionCheckpoint.bind(pagePersistence); let lostPageCheckpointACK = false;
  pagePersistence.saveExecutionCheckpoint = async checkpoint => { await actualPageCheckpoint(checkpoint);
    if (!lostPageCheckpointACK && checkpoint.execution?.reportPageSecret?.report?.pages.length === 1 && checkpoint.execution.readProgress?.attempts.report?.status === "PREPARING") {
      lostPageCheckpointACK = true; throw new Error("Synthetic actual Firestore report-page post-COMMIT acknowledgement loss");
    }
  };
  await start(pageRepository); await waitFor(() => lostPageCheckpointACK, "report page checkpoint post-COMMIT acknowledgement loss");
  pagePersistence.saveExecutionCheckpoint = actualPageCheckpoint; assert.throws(() => repository.assertAuthority());
  assert.deepEqual(reports.map(value => value.cursor), [""]);
  await stop(); await start(await openApplicationRepository(config));
  const scheduledExecution = await waitFor(async () => Object.values((await repository.snapshot()).executions).find(value => value.scheduleSource?.scheduledFor === scheduledFor && value.status === "AWAITING_APPROVAL"), "scheduled operation approval wait");
  assert.equal(operations.length, operationsBeforeSchedule); assert.equal(models.length, modelsBeforeSchedule);
  const scheduleStatus = (await request("GET", "/api/workflows/scheduledOperation/schedule", undefined, 200)).data;
  assert.equal(scheduleStatus.occurrences.filter(value => value.scheduledFor === scheduledFor).length, 1);
  const scheduledOccurrence = scheduleStatus.occurrences.find(value => value.scheduledFor === scheduledFor), expectedReportWindow = reportWindowFor("UTC", scheduledFor, "previous-calendar-day");
  assert.equal(scheduledOccurrence.executionId, scheduledExecution.id); assert.deepEqual(scheduledOccurrence.reportWindow, expectedReportWindow);
  assert.deepEqual(scheduledExecution.scheduleSource.reportWindow, expectedReportWindow); assert.deepEqual(scheduledExecution.scheduleSource.reportWindowBinding, reportWindowBinding);
  assert.match(scheduledExecution.scheduleSource.inputHash, /^sha256:[a-f0-9]{64}$/); assert.deepEqual(scheduledExecution.workflowSnapshot.input,
    { reportStartAt: expectedReportWindow.startAt, reportEndAt: expectedReportWindow.endAt });
  assert.deepEqual(reports, ["", "cursor-firestore-2", "cursor-firestore-3"].map(cursor => ({ startAt: expectedReportWindow.startAt, endAt: expectedReportWindow.endAt, cursor })));
  assert.equal(scheduledExecution.reportCoverage.profile, "schedule-report-coverage/v1"); assert.equal(scheduledExecution.reportCoverage.nodeId, "report");
  assert.equal(scheduledExecution.reportCoverage.toolId, reportTool.tool_id); assert.equal(scheduledExecution.reportCoverage.itemCount, 3);
  assert.equal(scheduledExecution.reportCoverage.startAt, expectedReportWindow.startAt); assert.equal(scheduledExecution.reportCoverage.endAt, expectedReportWindow.endAt);
  assert.equal(scheduledExecution.reportCoverage.pagination.profile, "report-cursor-evidence/v1"); assert.equal(scheduledExecution.reportCoverage.pagination.pageCount, 3);
  assert.match(scheduledExecution.reportCoverage.pagination.initialCursorHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(scheduledExecution.reportCoverage.pagination.totalCount, 3);
  assert.match(scheduledExecution.reportCoverage.pagination.snapshotHash, /^sha256:[a-f0-9]{64}$/);
  assert(!JSON.stringify(scheduledExecution).includes("snapshot-firestore-daily")); assert(!JSON.stringify(scheduledExecution).includes("cursor-firestore-"));
  const scheduleReview = (await request("GET", `/api/executions/${scheduledExecution.id}?view=approval`, undefined, 200, "reviewer")).data.runtimeApproval;
  await request("POST", `/api/executions/${scheduledExecution.id}/approve`, { approvalId: scheduleReview.id, baseVersion: scheduleReview.version,
    reviewHash: scheduleReview.reviewHash, decisionKey: "firestore-scheduled-operation-approval-0001" }, 200, "reviewer");
  await waitFor(async () => (await repository.snapshot()).executions[scheduledExecution.id].status === "DONE", "scheduled operation completion");
  assert.equal(operations.length, operationsBeforeSchedule + 1); assert.equal(models.length, modelsBeforeSchedule);
  const completedScheduledExecution = structuredClone((await repository.snapshot()).executions[scheduledExecution.id]);
  await stop(); await start(await openApplicationRepository(config));
  assert.deepEqual((await repository.snapshot()).executions[scheduledExecution.id], completedScheduledExecution);
  assert.equal(Object.values((await repository.snapshot()).executions).filter(value => value.scheduleSource?.scheduledFor === scheduledFor).length, 1);
  assert.equal(operations.length, operationsBeforeSchedule + 1); assert.deepEqual(reports.map(value => value.cursor), ["", "cursor-firestore-2", "cursor-firestore-3"]);
  log("actual Firestore daily schedule claim and first opaque-cursor report checkpoint survived separate post-COMMIT acknowledgement losses; restart resumed from the protected second cursor without replay, persisted three-page stable-snapshot/complete/exhausted/count evidence without raw cursors, required fresh independent approval, dispatched once and persisted without a model call");

  const relatedScheduledYAML = stringify({ name: "Scheduled related-record report", description: "Invoice keys must cover exact related orders", trigger: { type: "manual", config: { inputSchema: {
    type: "object", properties: { reportStartAt: { type: "string" }, reportEndAt: { type: "string" } },
    required: ["reportStartAt", "reportEndAt"], additionalProperties: false } } }, steps: [
    { id: "invoices", action: relatedInvoiceTool.name, parameters: { startAt: "{{input.reportStartAt}}", endAt: "{{input.reportEndAt}}" } },
    { id: "orders", action: relatedOrderTool.name, parameters: { startAt: "{{input.reportStartAt}}", endAt: "{{input.reportEndAt}}",
      orderIds: "{{invoices.structuredContent.orderIds}}" } },
    { id: "send", action: operationTool.name, parameters: { id: "{{orders.structuredContent.reportId}}" } },
  ] });
  await repository.mutate(state => { state.schedules["schedule-scheduledOperation"].state = "PAUSED"; state.schedules["schedule-scheduledOperation"].nextRunAt = null;
    state.workflows.relatedScheduledOperation = { ...state.workflows.operation, id: "relatedScheduledOperation",
    name: "Scheduled related-record report", yaml: relatedScheduledYAML, steps: 3, publishedVersion: 0, draftVersion: 1, canRun: false };
    state.versions.relatedScheduledOperation = []; });
  await request("POST", "/api/workflows/relatedScheduledOperation/publish", {}, 200);
  const relatedWorkflow = (await repository.snapshot()).workflows.relatedScheduledOperation;
  const relatedSchedule = (await request("PUT", "/api/workflows/relatedScheduledOperation/schedule", { profile: "workflow-daily-schedule-command/v1", baseRevision: 0,
    workflowVersion: relatedWorkflow.publishedVersion, workflowHash: workflowContentHash(relatedWorkflow.yaml), enabled: true, timezone: "UTC",
    localTime: new Date(Date.now() + 120_000).toISOString().slice(11, 16), reportingPeriod: "previous-calendar-day", misfirePolicy: "FIRE_ONCE",
    misfireGraceSeconds: 300, servicePrincipalId: "owner", input: {}, reportWindowBinding }, 200)).data;
  const relatedScheduledFor = relatedSchedule.nextRunAt, operationsBeforeRelatedSchedule = operations.length;
  assert.deepEqual(await workflowScheduleRunner(services).runDue(Date.parse(relatedScheduledFor)), { admitted: 1, skipped: 0, blocked: 0 });
  const relatedExecution = await waitFor(async () => Object.values((await repository.snapshot()).executions)
    .find(value => value.workflowId === "relatedScheduledOperation" && value.scheduleSource?.scheduledFor === relatedScheduledFor && value.status === "AWAITING_APPROVAL"),
  "related-record scheduled operation approval wait");
  const relatedWindow = reportWindowFor("UTC", relatedScheduledFor, "previous-calendar-day");
  assert.deepEqual(relatedInvoiceReports, [{ startAt: relatedWindow.startAt, endAt: relatedWindow.endAt }]);
  assert.deepEqual(relatedOrderReports, [{ startAt: relatedWindow.startAt, endAt: relatedWindow.endAt, orderIds: ["order-related-2", "order-related-1"] }]);
  assert.deepEqual(Object.keys(relatedExecution.reportCoverages).sort(), ["invoices", "orders"]);
  const projectedRelation = relatedExecution.reportCoverages.invoices.relatedRecords, matchedRelation = relatedExecution.reportCoverages.orders.relatedRecords;
  assert.equal(projectedRelation.mode, "PROJECTED"); assert.equal(matchedRelation.mode, "REQUESTED_MATCHED");
  assert.equal(projectedRelation.relationName, "invoice-orders"); assert.equal(matchedRelation.relationName, "invoice-orders");
  assert.equal(projectedRelation.keyCount, 2); assert.equal(matchedRelation.keyCount, 2); assert.equal(projectedRelation.keysHash, matchedRelation.keysHash);
  assert.equal(operations.length, operationsBeforeRelatedSchedule); assert.equal(models.length, modelsBeforeSchedule);
  const relatedExecutionBeforeRestart = structuredClone(relatedExecution); await stop(); await start(await openApplicationRepository(config));
  assert.deepEqual((await repository.snapshot()).executions[relatedExecution.id].reportCoverages, relatedExecutionBeforeRestart.reportCoverages);
  const relatedReview = (await request("GET", `/api/executions/${relatedExecution.id}?view=approval`, undefined, 200, "reviewer")).data.runtimeApproval;
  await request("POST", `/api/executions/${relatedExecution.id}/approve`, { approvalId: relatedReview.id, baseVersion: relatedReview.version,
    reviewHash: relatedReview.reviewHash, decisionKey: "firestore-related-report-approval-0001" }, 200, "reviewer");
  await waitFor(async () => (await repository.snapshot()).executions[relatedExecution.id].status === "DONE", "related-record scheduled operation completion");
  assert.equal(operations.length, operationsBeforeRelatedSchedule + 1); assert.equal(operations.at(-1), "related-report-operation");
  log("actual Firestore related-record schedule persisted and reloaded separate invoice/order receipts with one matching projected/requested key-set hash, then required fresh independent approval before one synthetic effect");

  const lostOperation = (await request("POST", "/api/workflows/operation/run", { mode: "async-operation", idempotencyKey: "firestore-operation-lost-intent-0001", input: { id: "operation-lost-intent" } }, 202)).data.id;
  await waitFor(async () => (await repository.snapshot()).executions[lostOperation].status === "AWAITING_APPROVAL", "lost-intent approval wait");
  const lostReview = (await request("GET", `/api/executions/${lostOperation}?view=approval`, undefined, 200, "reviewer")).data.runtimeApproval;
  const actualOperationCheckpoint = persistence.saveExecutionCheckpoint.bind(persistence); let lostOperationACK = false;
  persistence.saveExecutionCheckpoint = async checkpoint => { await actualOperationCheckpoint(checkpoint);
    if (!lostOperationACK && checkpoint.executionId === lostOperation && checkpoint.execution?.operationSecret?.intents.send?.state === "DISPATCH_INTENT") { lostOperationACK = true; throw new Error("Synthetic actual Firestore intent post-COMMIT acknowledgement lost"); }
  };
  await request("POST", `/api/executions/${lostOperation}/approve`, { approvalId: lostReview.id, baseVersion: lostReview.version, reviewHash: lostReview.reviewHash, decisionKey: "firestore-operation-lost-decision-0001" }, 200, "reviewer");
  await waitFor(() => lostOperationACK, "operation intent post-COMMIT acknowledgement loss"); persistence.saveExecutionCheckpoint = actualOperationCheckpoint;
  assert.equal(operations.length, operationsBeforeRelatedSchedule + 1); await repository.recoverPersistenceState();
  assert.equal((await repository.snapshot()).executions[lostOperation].operationSecret.intents.send.state, "DISPATCH_INTENT");
  await stop(); await start(await openApplicationRepository(config));
  const reconciledOperation = (await repository.snapshot()).executions[lostOperation]; assert.equal(reconciledOperation.status, "RECONCILIATION_REQUIRED");
  assert.equal(reconciledOperation.readProgress.attempts.send.status, "UNKNOWN"); assert.equal(reconciledOperation.stepOutputs.lookup.structuredContent.id, "OPERATION-LOST-INTENT");
  assert.equal(operations.length, operationsBeforeRelatedSchedule + 1); assert.equal(models.length, modelsBeforeOperation);
  log("actual Firestore post-COMMIT operation intent ACK loss fenced SDK entry; authoritative reload/restart preserved the read answer and unknown intent for reconciliation, without operation replay");

  // Explicit broker/helper qualification only, not a durable read-back job,
  // saved evidence ledger, recovery command or permission grant. Deliberately
  // omit the original executionId so this independent query cannot change its
  // audit timeline or turn the original unknown effect into an SDK answer.
  const readbackCase = (await request("GET", `/api/executions/${lostOperation}?view=reconciliation`, undefined, 200)).data.operationReconciliation;
  const readbackArgs = resolveOperationReadbackArguments(operationTool, readbackTool, readbackCase.arguments);
  assert.deepEqual(readbackArgs, { id: "OPERATION-LOST-INTENT" });
  const readbackSnapshot = await repository.snapshot();
  const beforeReadback = canonicalJSONBytes([readbackSnapshot.executions[lostOperation], readbackSnapshot.timelines[lostOperation], readbackSnapshot.executionEvents[lostOperation]]);
  await assert.rejects(() => dispatchReadTool(services, "reviewer", readbackTool.name, readbackArgs), /current actor is not authorized/);
  assert.equal(readbacks.length, 0);
  const readbackResult = await dispatchReadTool(services, "owner", readbackTool.name, readbackArgs);
  const evaluation = evaluateOperationReadback(operationTool, readbackTool, readbackCase.arguments, readbackResult, readbackCase.preparedAt);
  assert.equal(evaluation.outcome, "NOT_APPLIED"); assert.equal(evaluation.settled, true);
  assert.equal(evaluation.canResume, false); assert.equal(evaluation.noReplay, true); assert.equal(evaluation.deliveryVerified, false);
  assert.deepEqual(readbacks, ["OPERATION-LOST-INTENT"]); assert.equal(operations.length, operationsBeforeRelatedSchedule + 1); assert.equal(models.length, modelsBeforeOperation);
  const afterReadback = await repository.snapshot();
  assert(beforeReadback.equals(canonicalJSONBytes([afterReadback.executions[lostOperation], afterReadback.timelines[lostOperation], afterReadback.executionEvents[lostOperation]])));
  assert.equal(afterReadback.executions[lostOperation].status, "RECONCILIATION_REQUIRED");
  log("actual Firestore publication/restart retained exact separately reviewed read-back binding; an explicitly authorized synthetic broker query classified fresh settled evidence without changing, resending or resolving the original uncertain run; review-only dispatch was denied");

  // Normal read-back HTTP admission, durable worker and private saved evidence.
  // Query events append separately; no original effect/timeline/answer changes.
  const queryHistory = (await request("GET", `/api/executions/${lostOperation}/readbacks`, undefined, 200)).data;
  assert.equal(queryHistory.canQuery, true); assert.deepEqual(queryHistory.jobs, []);
  const normalQueryCommand = { intentId: queryHistory.intentId, baseVersion: queryHistory.baseVersion, factsHash: queryHistory.factsHash, idempotencyKey: "firestore-normal-query-0001" };
  await request("POST", `/api/executions/${lostOperation}/readbacks`, normalQueryCommand, 403, "reviewer");
  const normalQuery = (await request("POST", `/api/executions/${lostOperation}/readbacks`, normalQueryCommand, 202)).data;
  assert.equal(normalQuery.executionId, lostOperation); assert.equal(normalQuery.intentId, queryHistory.intentId); assert.equal(normalQuery.nodeId, queryHistory.nodeId);
  assert.equal(normalQuery.canCancel, undefined);
  await waitFor(async () => (await repository.snapshot()).executions[lostOperation].operationSecret.readbacks[normalQuery.id].state === "ANSWERED", "normal read-back saved evidence");
  const checkOriginalOperation = async () => {
    const saved = await repository.snapshot(), execution = saved.executions[lostOperation];
    assert.equal(execution.status, reconciledOperation.status); assert.equal(execution.completedAt, reconciledOperation.completedAt);
    assert.deepEqual(execution.operationSecret.intents, reconciledOperation.operationSecret.intents);
    assert.deepEqual(execution.stepOutputs, reconciledOperation.stepOutputs); assert.equal(execution.finalOutput, undefined);
    assert.equal(execution.readProgress.epoch, reconciledOperation.readProgress.epoch); assert.equal(execution.readProgress.nextStepIndex, reconciledOperation.readProgress.nextStepIndex);
    assert.deepEqual(saved.timelines[lostOperation], readbackSnapshot.timelines[lostOperation]);
    assert.equal(operations.length, operationsBeforeRelatedSchedule + 1); assert.equal(models.length, modelsBeforeOperation);
  };
  await checkOriginalOperation(); assert.equal(readbacks.length, 2);
  const savedQuery = (await repository.snapshot()).executions[lostOperation].operationSecret.readbacks[normalQuery.id];
  assert.equal(savedQuery.result.structuredContent.id, "OPERATION-LOST-INTENT"); assert.equal(savedQuery.evaluation.outcome, "NOT_APPLIED"); assert.equal(savedQuery.lease, undefined);
  const normalHistory = (await request("GET", `/api/executions/${lostOperation}/readbacks`, undefined, 200)).data;
  assert.equal(normalHistory.executionId, lostOperation); assert.equal(normalHistory.nodeId, queryHistory.nodeId);
  assert.equal(normalHistory.jobs[0].executionId, lostOperation); assert.equal(normalHistory.jobs[0].intentId, normalHistory.intentId); assert.equal(normalHistory.jobs[0].nodeId, normalHistory.nodeId);
  assert.equal(normalHistory.jobs[0].canCancel, false);
  assert.equal(normalHistory.jobs[0].observation.deliveryVerified, false); assert.equal(normalHistory.jobs[0].canResume, false);
  assert(!/"(?:arguments|result|admission|keyHash|connectionBinding)":/.test(JSON.stringify(normalHistory)));
  assert.equal((await request("POST", `/api/executions/${lostOperation}/readbacks`, normalQueryCommand, 202)).data.replayed, true);
  await stop(); await start(await openApplicationRepository(config));
  assert.deepEqual((await repository.snapshot()).executions[lostOperation].operationSecret.readbacks[normalQuery.id], savedQuery);
  await checkOriginalOperation(); assert.equal(readbacks.length, 2);
  log("actual Firestore normal status-query HTTP/worker saved private qualified evidence and separate events, survived fresh restart and original-key replay, denied review-only dispatch, and preserved the original unknown action/answers/timeline with zero effect/model replay");

  for (const phase of ["admission", "intent", "result"]) {
    const history = (await request("GET", `/api/executions/${lostOperation}/readbacks`, undefined, 200)).data;
    const previousIds = new Set(history.jobs.map(job => job.id)), readbacksBeforeLoss = readbacks.length;
    const command = { intentId: history.intentId, baseVersion: history.baseVersion, factsHash: history.factsHash, idempotencyKey: `firestore-query-${phase}-ack-0001` };
    const actualQueryCheckpoint = persistence.saveExecutionCheckpoint.bind(persistence); let lostQueryACK = false;
    persistence.saveExecutionCheckpoint = async checkpoint => {
      await actualQueryCheckpoint(checkpoint);
      const query = checkpoint.executionId === lostOperation && Object.values(checkpoint.execution?.operationSecret?.readbacks ?? {}).find(job => !previousIds.has(job.id));
      if (!lostQueryACK && query && (phase === "admission" ? query.state === "QUEUED" : phase === "intent" ? query.state === "RUNNING" && query.dispatchIntentAt : query.state === "ANSWERED")) {
        lostQueryACK = true; throw new Error(`Synthetic actual Firestore query ${phase} post-COMMIT acknowledgement lost`);
      }
    };
    await request("POST", `/api/executions/${lostOperation}/readbacks`, command, phase === "admission" ? 503 : 202);
    await waitFor(() => lostQueryACK, `query ${phase} post-COMMIT acknowledgement loss`);
    assert.throws(() => repository.assertAuthority()); await request("GET", `/api/executions/${lostOperation}/readbacks`, undefined, 503);
    persistence.saveExecutionCheckpoint = actualQueryCheckpoint; await repository.recoverPersistenceState();
    const recovered = Object.values((await repository.snapshot()).executions[lostOperation].operationSecret.readbacks).find(job => !previousIds.has(job.id));
    assert(recovered); await stop(); await start(await openApplicationRepository(config));
    const expected = phase === "intent" ? "RECOVERY_REQUIRED" : "ANSWERED";
    await waitFor(async () => (await repository.snapshot()).executions[lostOperation].operationSecret.readbacks[recovered.id].state === expected, `query ${phase} authoritative recovery`);
    const recoveredHistory = (await request("GET", `/api/executions/${lostOperation}/readbacks`, undefined, 200)).data;
    assert.equal(recoveredHistory.jobs.find(job => job.id === recovered.id).state, expected);
    if (phase === "intent") assert.equal(recoveredHistory.jobs.find(job => job.id === recovered.id).observation, null);
    const replay = (await request("POST", `/api/executions/${lostOperation}/readbacks`, command, 202)).data;
    assert.equal(replay.id, recovered.id); assert.equal(replay.replayed, true);
    assert.equal(readbacks.length, readbacksBeforeLoss + (phase === "intent" ? 0 : 1)); await checkOriginalOperation();
    log(`actual Firestore normal read-back ${phase} post-COMMIT ACK loss returned unavailable history, recovered one original-key record across fresh restart, and never replayed an entered query or the original effect`);
  }

  // A qualified status answer is still not an SDK ACK. Exercise independent
  // acceptance of the immutable saved query, real scoped Firestore commits,
  // unknown decision ACK and restart—not a browser-supplied outcome.
  await repository.mutate(state => {
    state.roles.recovery_operator = { id: "recovery_operator", name: "Independent recovery operator", description: "Synthetic recovery only", permissions: ["execution:reconcile"], createdAt: new Date().toISOString() };
    state.users.operator = { ...state.users.reviewer, id: "operator", name: "Recovery operator", email: "operator@example.test", roleId: "recovery_operator" };
  });
  const recoveryView = (await request("GET", `/api/executions/${lostOperation}?view=reconciliation`, undefined, 200, "operator")).data.operationReconciliation;
  const recoveryInbox = (await request("GET", "/api/execution-reviews?kind=reconciliation", undefined, 200, "operator")).data;
  assert.deepEqual(recoveryInbox.scopes, { approval: false, reconciliation: true });
  assert(recoveryInbox.items.some(item => item.executionId === lostOperation && item.statusLabel === "Outcome uncertain" && item.actionable));
  assert(!JSON.stringify(recoveryInbox).includes('"arguments":')); assert(!JSON.stringify(recoveryInbox).includes("OPERATION-LOST-INTENT"));
  assert.equal(recoveryView.canRecord, true); assert.deepEqual(recoveryView.arguments, { id: "OPERATION-LOST-INTENT" });
  await request("GET", `/api/executions/${lostOperation}`, undefined, 404, "operator"); await request("GET", `/api/executions/${lostOperation}/logs`, undefined, 403, "operator");
  const operatorQueryHistory = (await request("GET", `/api/executions/${lostOperation}/readbacks`, undefined, 200, "operator")).data;
  assert.equal(operatorQueryHistory.jobs.find(job => job.id === normalQuery.id).canResolve, true);
  const recoveryCommand = { intentId: recoveryView.intentId, baseVersion: recoveryView.version, factsHash: recoveryView.factsHash,
    decisionKey: "firestore-query-resolution-0001", queryId: normalQuery.id };
  await request("POST", `/api/executions/${lostOperation}/reconcile`, recoveryCommand, 403, "owner");
  const actualRecoveryCheckpoint = persistence.saveExecutionCheckpoint.bind(persistence); let lostRecoveryACK = false;
  persistence.saveExecutionCheckpoint = async checkpoint => { await actualRecoveryCheckpoint(checkpoint);
    if (!lostRecoveryACK && checkpoint.executionId === lostOperation && checkpoint.execution?.status === "RECONCILED") { lostRecoveryACK = true; throw new Error("Synthetic actual Firestore query-backed decision post-COMMIT acknowledgement loss"); }
  };
  await request("POST", `/api/executions/${lostOperation}/reconcile`, recoveryCommand, 503, "operator"); assert.equal(lostRecoveryACK, true);
  persistence.saveExecutionCheckpoint = actualRecoveryCheckpoint; await repository.recoverPersistenceState();
  const closedRecovery = (await repository.snapshot()).executions[lostOperation]; assert.equal(closedRecovery.status, "RECONCILED");
  assert.equal(closedRecovery.operationSecret.intents.send.state, "UNKNOWN"); assert.equal(closedRecovery.readProgress.attempts.send.status, "UNKNOWN");
  assert.deepEqual(closedRecovery.stepOutputs, reconciledOperation.stepOutputs); assert.equal(closedRecovery.finalOutput, undefined);
  const recoveryEvents = (await repository.snapshot()).executionEvents[lostOperation];
  assert.equal((await request("POST", `/api/executions/${lostOperation}/reconcile`, recoveryCommand, 200, "operator")).data.replayed, true);
  assert.deepEqual((await repository.snapshot()).executionEvents[lostOperation], recoveryEvents);
  await stop(); await start(await openApplicationRepository(config));
  assert.deepEqual((await repository.snapshot()).executions[lostOperation], closedRecovery);
  const recoveryHistory = (await request("GET", `/api/executions/${lostOperation}?view=reconciliation`, undefined, 200, "operator")).data.operationReconciliation;
  assert(!(await request("GET", "/api/execution-reviews", undefined, 200, "operator")).data.items.some(item => item.executionId === lostOperation));
  const recoveryHistoryInbox = (await request("GET", "/api/execution-reviews?state=closed", undefined, 200, "operator")).data;
  assert(recoveryHistoryInbox.items.some(item => item.executionId === lostOperation && !item.actionable && item.statusLabel === "Closed by reviewed ERP status"));
  assert.equal(recoveryHistory.state, "RESOLVED"); assert.equal(recoveryHistory.canRecord, false); assert.equal(recoveryHistory.history.length, 1);
  assert.equal(recoveryHistory.history[0].basis, "queried-operation-state"); assert.equal(recoveryHistory.history[0].queryId, normalQuery.id);
  assert.equal(recoveryHistory.history[0].observation.outcome, "NOT_APPLIED"); assert.equal(recoveryHistory.canResume, false);
  const closedQueryHistory = (await request("GET", `/api/executions/${lostOperation}/readbacks`, undefined, 200, "operator")).data;
  assert.equal(closedQueryHistory.canQuery, false); assert.equal(closedQueryHistory.jobs.length, 4);
  assert(closedQueryHistory.jobs.every(job => job.executionId === lostOperation && job.intentId === closedQueryHistory.intentId && job.nodeId === closedQueryHistory.nodeId && job.canCancel === false));
  assert.equal(closedQueryHistory.jobs.find(job => job.id === normalQuery.id).observation.outcome, "NOT_APPLIED");
  const recoveryPlanHistory = (await request("GET", `/api/executions/${lostOperation}/recovery-artifacts`, undefined, 200, "owner")).data;
  assert.equal(recoveryPlanHistory.state, "CLOSED_NOT_APPLIED"); assert.equal(recoveryPlanHistory.canCreate, true); assert.equal(recoveryPlanHistory.artifacts.length, 0);
  const recoveryPlanCommand = { intentId: recoveryPlanHistory.intentId, sourceVersion: recoveryPlanHistory.sourceVersion, factsHash: recoveryPlanHistory.factsHash,
    reconciliationId: recoveryPlanHistory.reconciliationId, queryId: recoveryPlanHistory.queryId, idempotencyKey: "firestore-linked-recovery-plan-0001" };
  const beforeRecoveryPlanCalls = operations.length, beforeRecoveryPlanModels = models.length;
  const actualRecoveryPlanCheckpoint = persistence.saveExecutionCheckpoint.bind(persistence); let lostRecoveryPlanACK = false;
  persistence.saveExecutionCheckpoint = async checkpoint => { await actualRecoveryPlanCheckpoint(checkpoint);
    if (!lostRecoveryPlanACK && checkpoint.executionId === lostOperation && Object.keys(checkpoint.execution?.operationSecret?.recoveries ?? {}).length === 1) {
      lostRecoveryPlanACK = true; throw new Error("Synthetic actual Firestore linked-recovery post-COMMIT acknowledgement loss");
    }
  };
  await request("POST", `/api/executions/${lostOperation}/recovery-artifacts`, recoveryPlanCommand, 503, "owner"); assert.equal(lostRecoveryPlanACK, true);
  persistence.saveExecutionCheckpoint = actualRecoveryPlanCheckpoint; await repository.recoverPersistenceState();
  const recoveredPlanHistory = (await request("GET", `/api/executions/${lostOperation}/recovery-artifacts`, undefined, 200, "owner")).data;
  assert.equal(recoveredPlanHistory.canCreate, false); assert.equal(recoveredPlanHistory.artifacts.length, 1); assert.equal(recoveredPlanHistory.artifacts[0].dispatchAuthority, false);
  assert.equal(recoveredPlanHistory.artifacts[0].source.executionId, lostOperation); assert.equal(recoveredPlanHistory.artifacts[0].source.queryId, normalQuery.id);
  assert.equal((await request("POST", `/api/executions/${lostOperation}/recovery-artifacts`, recoveryPlanCommand, 200, "owner")).data.replayed, true);
  const savedRecoveryPlan = structuredClone((await repository.snapshot()).executions[lostOperation]);
  await stop(); await start(await openApplicationRepository(config)); assert.deepEqual((await repository.snapshot()).executions[lostOperation], savedRecoveryPlan);
  assert.equal(operations.length, beforeRecoveryPlanCalls); assert.equal(models.length, beforeRecoveryPlanModels);
  const readyRecoveryPlan = (await request("GET", `/api/executions/${lostOperation}/recovery-artifacts`, undefined, 200, "owner")).data;
  assert.equal(readyRecoveryPlan.canAdmit, true); assert.equal(readyRecoveryPlan.linkedExecution, null);
  const recoveryArtifact = readyRecoveryPlan.artifacts[0], recoveryAdmissionCommand = { artifactHash: recoveryArtifact.artifactHash, idempotencyKey: "firestore-recovery-admission-0001" };
  const actualRecoveryAdmissionSave = persistence.save.bind(persistence); let lostRecoveryAdmissionACK = false;
  persistence.save = async payload => { await actualRecoveryAdmissionSave(payload); if (!lostRecoveryAdmissionACK) { lostRecoveryAdmissionACK = true; throw new Error("Synthetic actual Firestore recovery-admission post-COMMIT acknowledgement loss"); } };
  await request("POST", `/api/executions/${lostOperation}/recovery-artifacts/${recoveryArtifact.id}/admit`, recoveryAdmissionCommand, 503, "owner"); assert.equal(lostRecoveryAdmissionACK, true);
  persistence.save = actualRecoveryAdmissionSave; await repository.recoverPersistenceState();
  const admittedHistory = (await request("GET", `/api/executions/${lostOperation}/recovery-artifacts`, undefined, 200, "owner")).data;
  assert.equal(admittedHistory.canAdmit, false); assert(admittedHistory.linkedExecution); const recoveryExecution = admittedHistory.linkedExecution.executionId;
  assert.notEqual(recoveryExecution, lostOperation); assert.equal((await repository.snapshot()).executions[recoveryExecution].status, "PENDING");
  assert.equal(operations.length, beforeRecoveryPlanCalls); assert.equal(models.length, beforeRecoveryPlanModels);
  await stop(); await start(await openApplicationRepository(config));
  await waitFor(async () => (await repository.snapshot()).executions[recoveryExecution].status === "AWAITING_APPROVAL", "separate recovery fresh approval wait");
  const freshRecoveryApproval = (await request("GET", `/api/executions/${recoveryExecution}?view=approval`, undefined, 200, "reviewer")).data.runtimeApproval;
  assert.deepEqual(freshRecoveryApproval.arguments, { id: "OPERATION-LOST-INTENT" }); assert.equal(freshRecoveryApproval.state, "PENDING");
  assert.equal((await request("POST", `/api/executions/${lostOperation}/recovery-artifacts/${recoveryArtifact.id}/admit`, recoveryAdmissionCommand, 202, "owner")).data.replayed, true);
  await request("POST", `/api/executions/${recoveryExecution}/approve`, { approvalId: freshRecoveryApproval.id, baseVersion: freshRecoveryApproval.version,
    reviewHash: freshRecoveryApproval.reviewHash, decisionKey: "firestore-recovery-fresh-approval-0001" }, 200, "reviewer");
  await waitFor(async () => (await repository.snapshot()).executions[recoveryExecution].status === "DONE", "separate recovery completion");
  const completedRecovery = structuredClone((await repository.snapshot()).executions[recoveryExecution]); assert.equal(completedRecovery.recoverySource.sourceExecutionId, lostOperation);
  assert.equal(completedRecovery.operationSecret.intents.recover_action.state, "ACKNOWLEDGED"); assert.equal(operations.length, beforeRecoveryPlanCalls + 1); assert.equal(models.length, beforeRecoveryPlanModels);
  assert.deepEqual((await repository.snapshot()).executions[lostOperation], savedRecoveryPlan);
  await stop(); await start(await openApplicationRepository(config)); assert.deepEqual((await repository.snapshot()).executions[recoveryExecution], completedRecovery);
  assert.deepEqual((await repository.snapshot()).executions[lostOperation], savedRecoveryPlan); assert.equal(operations.length, beforeRecoveryPlanCalls + 1);
  await request("POST", `/api/executions/${lostOperation}/retry`, {}, 409); assert.equal(operations.length, beforeRecoveryPlanCalls + 1); assert.equal(models.length, modelsBeforeOperation);
  log("actual Firestore recovery admission survived post-COMMIT acknowledgement loss as one new execution, required fresh independent approval, dispatched one separately journaled synthetic action and never mutated or resumed the source run");
  log("actual Firestore immutable linked recovery survived post-COMMIT acknowledgement loss, same-key replay and fresh restart without dispatch, source-run mutation or model use");
  log("actual Firestore independent query-backed resolution survived post-COMMIT decision ACK loss, authoritative original-key replay and fresh application restart; the server derived one private decision from the saved observation with no new SDK/model call, fabricated answer or resume");
  log("actual Firestore review inbox discovered independent normal waits and uncertain effects after restart, then preserved truthful approval/query-backed decision history without arguments, self-review or new SDK/model calls");

  const historicalYAML = stringify({ name: "Two independent synthetic reviews", description: "Verify separate exact decisions and historical review after a durable restart using synthetic operations only.", trigger: { type: "manual" }, steps: [
    { id: "first", action: operationTool.name, parameters: { id: "history-first" } },
    { id: "second", action: operationTool.name, parameters: { id: "{{first.structuredContent.id}}" } },
  ] });
  await repository.mutate(state => { state.workflows.multi_review_history = { ...state.workflows.operation, id: "multi_review_history", name: "Two independent synthetic reviews", yaml: historicalYAML,
    publishedVersion: 0, draftVersion: 1, steps: 2, canRun: false }; state.versions.multi_review_history = []; });
  await request("POST", "/api/workflows/multi_review_history/publish", {}, 200);
  const operationsBeforeHistory = operations.length, modelsBeforeHistory = models.length;
  const historyRun = (await request("POST", "/api/workflows/multi_review_history/run", { mode: "async-operation", idempotencyKey: "firestore-multi-review-history-0001" }, 202)).data.id;
  await waitFor(async () => (await repository.snapshot()).executions[historyRun].status === "AWAITING_APPROVAL", "first historical operation review");
  const firstHistorical = (await request("GET", `/api/executions/${historyRun}?view=approval`, undefined, 200, "reviewer")).data.runtimeApproval;
  await request("POST", `/api/executions/${historyRun}/approve`, { approvalId: firstHistorical.id, baseVersion: firstHistorical.version, reviewHash: firstHistorical.reviewHash, decisionKey: "firestore-historical-first-0001" }, 200, "reviewer");
  await waitFor(async () => { const run = (await repository.snapshot()).executions[historyRun]; return run.status === "AWAITING_APPROVAL" && run.runtimeApprovalSecret.activeId !== firstHistorical.id; }, "second independent operation review");
  const secondHistorical = (await request("GET", `/api/executions/${historyRun}?view=approval`, undefined, 200, "reviewer")).data.runtimeApproval;
  assert.notEqual(firstHistorical.id, secondHistorical.id); assert.equal(operations.length, operationsBeforeHistory + 1);
  const oldBeforeRestart = (await request("GET", `/api/executions/${historyRun}?view=approval&approvalId=${encodeURIComponent(firstHistorical.id)}`, undefined, 200, "reviewer")).data.runtimeApproval;
  assert.equal(oldBeforeRestart.state, "CONSUMED"); assert.equal(oldBeforeRestart.canDecide, false);
  await stop(); await start(await openApplicationRepository(config));
  const oldAfterRestart = (await request("GET", `/api/executions/${historyRun}?view=approval&approvalId=${encodeURIComponent(firstHistorical.id)}`, undefined, 200, "reviewer")).data.runtimeApproval;
  assert.deepEqual(oldAfterRestart, oldBeforeRestart); assert.equal(operations.length, operationsBeforeHistory + 1);
  await request("POST", `/api/executions/${historyRun}/approve`, { approvalId: secondHistorical.id, baseVersion: secondHistorical.version, reviewHash: secondHistorical.reviewHash, decisionKey: "firestore-historical-second-0001" }, 200, "reviewer");
  await waitFor(async () => (await repository.snapshot()).executions[historyRun].status === "DONE", "historical operation completion");
  const historyFirstPage = (await request("GET", "/api/execution-reviews?kind=approval&state=closed&limit=1", undefined, 200, "reviewer")).data;
  const historySecondPage = (await request("GET", `/api/execution-reviews?kind=approval&state=closed&limit=1&cursor=${encodeURIComponent(historyFirstPage.nextCursor)}`, undefined, 200, "reviewer")).data;
  assert.equal(historyFirstPage.items[0].executionId, historyRun); assert.equal(historySecondPage.items[0].executionId, historyRun);
  assert.deepEqual([historyFirstPage.items[0].reviewId, historySecondPage.items[0].reviewId], [secondHistorical.id, firstHistorical.id]);
  assert.equal(operations.length, operationsBeforeHistory + 2); assert.equal(models.length, modelsBeforeHistory);
  log("actual Firestore multi-operation wait/restart retained both exact independent reviews; record-bound history links and signed pages inspect earlier decisions without another SDK/model call or reapproval");

  const policyMetadata = (await request("GET", "/api/settings/runtime-approval-policy", undefined, 200)).data;
  assert.equal(policyMetadata.canManage, true); assert.equal(policyMetadata.memoryOnly, false);
  assert(policyMetadata.roles.some(role => role.id === "approval_fixture" && role.eligible));
  await request("GET", "/api/settings/runtime-approval-policy", undefined, 403, "reviewer");
  const { revision: policyRevision, ...policyConfiguration } = policyMetadata.policy;
  const policyCommand = { ...policyConfiguration, baseRevision: policyRevision, ttlSeconds: 600 };
  const policyTransaction = persistence.records.db.runTransaction.bind(persistence.records.db); let losePolicyACK = true;
  persistence.records.db.runTransaction = async (callback, options) => {
    let activated = false;
    const result = await policyTransaction(async transaction => {
      const set = transaction.set; transaction.set = function (ref, ...args) { if (ref.path === persistence.records.headPath) activated = true; return set.call(this, ref, ...args); };
      return callback(transaction);
    }, options);
    if (activated && losePolicyACK) { losePolicyACK = false; throw new Error("Synthetic policy post-COMMIT ACK lost"); }
    return result;
  };
  try { await request("PATCH", "/api/settings/rbac", { runtimeApprovalPolicy: policyCommand }, 503); }
  finally { persistence.records.db.runTransaction = policyTransaction; }
  await request("GET", "/api/settings/runtime-approval-policy", undefined, 503);
  await repository.recoverPersistenceState(); await stop(); await start(await openApplicationRepository(config));
  const recoveredPolicy = (await request("GET", "/api/settings/runtime-approval-policy", undefined, 200)).data;
  assert.equal(recoveredPolicy.revision, policyRevision + 1); assert.equal(recoveredPolicy.policy.ttlSeconds, 600);
  await request("PATCH", "/api/settings/rbac", { runtimeApprovalPolicy: policyCommand }, 409);
  assert.equal((await repository.snapshot()).auditLogs.filter(item => item.action === "runtime_approval.policy_changed").length, policyRevision + 1);
  assert.equal(operations.length, operationsBeforeHistory + 2); assert.equal(models.length, modelsBeforeHistory);
  log("actual Firestore approval administration policy post-COMMIT ACK loss fenced stale metadata; authoritative reload/restart retained one new revision/audit and rejected resubmission without a tool/model call or permission grant");

  const entered = barrier(), release = barrier(); sdkHook = async args => { if (args.id === "cancel-a") { entered.release(); await release.promise; } };
  const cancelRun = (await request("POST", "/api/workflows/collection/run", { mode: "async-read", idempotencyKey: "firestore-runtime-cancel-fixture-0001", input: { rows: ["cancel-a", "must-not-call"] } }, 202)).data.id;
  await boundedOperation(() => entered.promise, { timeoutMs: 20_000, label: "Synthetic cancellation SDK entry" }); await request("POST", `/api/executions/${cancelRun}/cancel`, {}, 202); release.release(); sdkHook = undefined;
  const cancelled = await waitFor(async () => { const current = await repository.snapshot(); return current.readJobs[cancelRun]?.state === "FINISHED" && current.executions[cancelRun]; }, "cancelled collection");
  assert.equal(cancelled.status, "CANCELLED"); assert(!calls.includes("must-not-call"));
  assert.equal(cancelled.stepOutputs["each/0/lookup"].structuredContent.id, "CANCEL-A"); log("normal cancellation retained the already-confirmed item answer and never started the next collection item");

  // Actual normal result checkpoint: inject pre/post-COMMIT ACK loss only on the
  // next metadata activation, not on unrelated read-only/lease operations.
  for (const phase of ["before", "after"]) {
    const actualTransaction = persistence.records.db.runTransaction.bind(persistence.records.db); let loseNextResult = false, lostResult = false, unavailableSignals = 0;
    const beforeIds = new Set(Object.keys((await repository.snapshot()).executions));
    const unobserve = repository.observeCommits({ committed: () => {}, unavailable: () => { unavailableSignals++; assert.throws(() => repository.assertAuthority()); } });
    persistence.records.db.runTransaction = async (callback, options) => {
      let activated = false;
      const result = await actualTransaction(async transaction => {
        const set = transaction.set; transaction.set = function (ref, ...args) { if (ref.path === persistence.records.headPath && loseNextResult) activated = true; return set.call(this, ref, ...args); };
        try {
          const value = await callback(transaction);
          if (activated && loseNextResult && phase === "before") { loseNextResult = false; lostResult = true; throw new Error("Synthetic pre-COMMIT result acknowledgement lost"); }
          return value;
        } finally { transaction.set = set; }
      }, options);
      if (activated && loseNextResult && phase === "after") { loseNextResult = false; lostResult = true; throw new Error("Synthetic post-COMMIT result acknowledgement lost"); }
      return result;
    };
    const requested = `lost-result-${phase}`; sdkHook = async args => { if (args.id === requested) loseNextResult = true; };
    const uncertain = await app.inject({ method: "POST", url: "/api/workflows/collection/run", headers: headers(), payload: { input: { rows: [requested, "no-replay"] } } });
    assert(lostResult); assert(unavailableSignals >= 1); assert(!calls.includes("no-replay")); assert.equal(uncertain.statusCode, 503);
    persistence.records.db.runTransaction = actualTransaction; sdkHook = undefined; unobserve();
    // The normal runner already performs authoritative reload/reconciliation;
    // it can restore healthy storage, never the stopped controller's execution.
    await repository.recoverPersistenceState();
    const current = await repository.snapshot(), recoverable = Object.values(current.executions).find(run => !beforeIds.has(run.id));
    assert(recoverable); assert.equal(recoverable.status, "RECOVERY_REQUIRED"); assert.equal(calls.filter(id => id === requested).length, 1);
    if (phase === "after") assert.equal(recoverable.stepOutputs["each/0/lookup"].structuredContent.id, requested.toUpperCase());
    else { assert.equal(recoverable.stepOutputs?.["each/0/lookup"], undefined); assert.equal(recoverable.readProgress.attempts["each/0/lookup"].status, "UNKNOWN"); }
    await stop(); await start(await openApplicationRepository(config));
    assert.deepEqual((await repository.snapshot()).executions[recoverable.id], recoverable); assert(!calls.includes("no-replay"));
  }
  log("actual normal collection pre/post-COMMIT result lost ACKs fenced the old cache; authoritative reconciliation/restart preserved confirmed versus UNKNOWN outcomes without replay or next-item dispatch");

  // Actual writer renewal ACK loss, followed by direct broker, model and HTTP
  // attempts. No stale worker/process cache may authorize another request.
  const heldEntry = barrier(), heldRelease = barrier(); sdkHook = async args => { if (args.id === "held-owner") { heldEntry.release(); await heldRelease.promise; } };
  const heldId = (await request("POST", "/api/workflows/collection/run", { mode: "async-read", idempotencyKey: "firestore-runtime-held-owner-0001", input: { rows: ["held-owner", "no-stale-next"] } }, 202)).data.id;
  await boundedOperation(() => heldEntry.promise, { timeoutMs: 20_000, label: "Synthetic owned worker SDK entry" });
  const heldModelEntry = barrier(), heldModelRelease = barrier(); let heldModelSignal;
  modelHook = async (_request, signal) => { heldModelSignal = signal; heldModelEntry.release(); await heldModelRelease.promise; };
  const heldChat = (await request("POST", `/api/chat/sessions/${chatId}/messages`, { ...chatPayload, content: "Show pending invoice details", idempotencyKey: "firestore-runtime-held-chat-0001" }, 202)).data.operation.id;
  await boundedOperation(() => heldModelEntry.promise, { timeoutMs: 20_000, label: "Synthetic owned chat model entry" });
  const nextSession = (await request("POST", "/api/chat/sessions", {}, 201)).data.id;
  const nextChat = (await request("POST", `/api/chat/sessions/${nextSession}/messages`, { ...chatPayload, content: "Do not start the next queued chat", idempotencyKey: "firestore-runtime-next-chat-0001" }, 202)).data.operation.id;
  const beforeLoss = await repository.snapshot(); assert.equal(beforeLoss.chatOperations[heldChat].status, "RUNNING"); assert.equal(beforeLoss.chatOperations[nextChat].status, "QUEUED");
  let unavailableSignals = 0; repository.observeCommits({ committed: () => {}, unavailable: () => { unavailableSignals++; } });
  const actual = persistence.records.db.runTransaction.bind(persistence.records.db);
  persistence.records.db.runTransaction = async (callback, options) => { await actual(callback, options); throw new Error("Synthetic post-COMMIT writer renewal ACK lost"); };
  await assert.rejects(persistence.renewOwnership()); persistence.records.db.runTransaction = actual;
  const callsBeforeFence = calls.length, modelsBeforeFence = models.length; assert.equal(unavailableSignals, 1);
  assert(heldModelSignal?.aborted, "The pending chat model wait must abort immediately on storage denial");
  heldRelease.release(); heldModelRelease.release(); sdkHook = modelHook = undefined;
  await assert.rejects(dispatchReadTool(services, "owner", "read", { id: "fenced" }));
  await assert.rejects(session.callToolDirect("read", { id: "fenced" })); await assert.rejects(services.providerRuntime.queryWithTools([{ role: "user", content: "fenced" }], [], { temperature: 0 }));
  const denied = await app.inject({ method: "POST", url: "/api/workflows/single/run", headers: headers(), payload: { input: { id: "fenced" } } }); assert(denied.statusCode >= 400);
  const deniedInbox = await request("GET", "/api/execution-reviews", undefined, 503, "reviewer");
  assert.equal(deniedInbox.success, false); assert.equal(deniedInbox.data, null);
  assert.equal(calls.length, callsBeforeFence); assert.equal(models.length, modelsBeforeFence); await assert.rejects(persistence.load());
  await app.close(); app = undefined;
  const observer = FirestoreRecordStore.create(key, namespace);
  try {
    const remote = assembleFirestoreState(observer.readRecords(await observer.load()));
    assert.equal(remote.executions[heldId].readProgress.attempts["each/0/lookup"].status, "DISPATCH_INTENT"); assert.equal(remote.executions[heldId].stepOutputs?.["each/0/lookup"], undefined);
    assert.deepEqual(remote.chatOperations[heldChat], beforeLoss.chatOperations[heldChat]); assert.deepEqual(remote.chatOperations[nextChat], beforeLoss.chatOperations[nextChat]);
    assert.deepEqual(remote.chats, beforeLoss.chats); assert.equal(calls.length, callsBeforeFence); assert.equal(models.length, modelsBeforeFence);
    assert(!calls.includes("no-stale-next"));
  } finally { await observer.close(); }
  log("actual writer-renewal lost ACK synchronously denied repository observers, pending read/chat waits, broker MCP, provider fetch and normal HTTP execution; late SDK/model answers were not saved and no next item or queued chat started");
  console.log("Firestore runtime qualification complete. Synthetic actual database + in-process HTTP/MCP/model fixtures only; no cloud project, live ERP/model/email, migration, browser/load or production latency certification.");
} finally { for (const gate of ownedBarriers) gate.release(); sdkHook = modelHook = undefined; await stop(); }

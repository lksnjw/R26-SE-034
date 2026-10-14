import { performance } from "node:perf_hooks";
import os from "node:os";
import jwt from "jsonwebtoken";
import { stringify } from "yaml";
import { loadConfig } from "../src/config/config.js";
import { buildApp } from "../src/http/app.js";
import { Repository } from "../src/repository/store.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { toolSchema } from "../src/registry/schemas.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { bridgeTransportSchema, exactBridgeName } from "../src/tools/erpbridge-contract.js";
import {
  admissionAuthorizer,
  capabilityContractHash,
  observeCapabilities,
  reviewCapability,
} from "../src/registry/capability-admission.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import { validateWorkspaceDraft } from "../src/workflows/draft-validation.js";
import { evaluateLatencyBudget, summarizeLatency } from "../src/performance/latency-report.js";

process.env.NODE_ENV ??= "test";
const LANES = integerSetting("LATENCY_LANES", 10, 1, 20);
const SAMPLES_PER_LANE = integerSetting("LATENCY_SAMPLES_PER_LANE", 5, 1, 100);
const WARMUPS_PER_LANE = integerSetting("LATENCY_WARMUPS_PER_LANE", 1, 0, 10);
const ENFORCE = process.argv.includes("--enforce");
const WAIT_TIMEOUT_MS = 30_000;

const tool = toolSchema.parse({
  tool_id: "LOCAL-LATENCY-ECHO",
  name: "benchmark.echo",
  mcp_tool_name: "benchmark.echo",
  description: "Injected local latency fixture; never a live ERP tool.",
  input_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  required_parameters: ["value"],
  allowed_roles: ["Platform Admin"],
  is_read_only: true,
  risk_level: "low",
  bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [] },
});
const registrySnapshot = Object.freeze({ tools: Object.freeze([tool]), rules: Object.freeze([]), versions: Object.freeze({ tools: "local-latency-v1", rules: "local-latency-v1" }) });
const registryHash = capabilityContractHash(tool);
const registries = {
  snapshot: () => registrySnapshot,
  hash: () => registryHash,
  findTool: name => [tool.tool_id, tool.name, tool.mcp_tool_name].includes(name) ? tool : undefined,
  findRule: () => undefined,
  enabledRules: () => [],
  onToolUpsert: () => () => undefined,
};

const config = loadConfig({
  APP_ENV: "test",
  JWT_SECRET: "local-latency-secret-at-least-32-bytes",
  STORAGE_DRIVER: "memory",
  STORAGE_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  MCP_MODE: "remote",
  MCP_TRANSPORT: "erpbridge-mcp",
  MCP_TIMEOUT_MS: "2000",
  ERPBRIDGE_BASE_URL: "https://local-latency.example.test",
  ERPBRIDGE_MCP_TOKEN: "local-latency-private-fixture",
  ERPBRIDGE_ROLE_MAP: JSON.stringify({ "Platform Admin": "benchmark_admin" }),
  READ_WORKER_CONCURRENCY: "8",
  READ_WORKER_PER_ACTOR: "1",
  READ_WORKER_LEASE_MS: "30000",
});
const repository = await Repository.open(null);
const validator = new RegistryValidator(registries, repository);
const sdkClient = Object.freeze({
  metadataComplete: true,
  connect: async () => undefined,
  close: async () => undefined,
  listTools: async () => [{
    name: exactBridgeName(tool),
    inputSchema: bridgeTransportSchema(tool),
    _meta: {
      "toolplane.resourceDigest": tool.bridge_contract.resource_digest,
      "toolplane.resourceVersion": tool.bridge_contract.resource_version,
      "io.erpbridge/allowedRoles": [],
    },
  }],
  callTool: async (_name, args) => ({ content: [{ type: "text", text: String(args.value ?? "") }] }),
});
const session = await createErpbridgeMcpSession({
  baseURL: config.erpbridgeBaseURL,
  token: config.erpbridgeMcpToken,
  timeoutMs: config.mcpTimeoutMs,
  validator,
  sdkClient,
  admissionAuthorizer: admissionAuthorizer(repository, registries),
});
const services = { config, repository, registries, validator, executor: new Executor(new ToolRegistry(), validator), erpbridgeSession: session };
let app;

try {
  const now = new Date().toISOString();
  await repository.mutate(state => {
    for (let lane = 0; lane < LANES; lane++) {
      const id = `bench_${lane}`;
      state.users[id] = { id, name: `Benchmark ${lane}`, email: `${id}@example.test`, roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "B", departmentId: null, lastLoginAt: null, createdAt: now };
    }
  });
  const reviewer = await repository.effectiveUser("bench_0");
  if (!reviewer) throw new Error("benchmark reviewer was not initialized");
  const observation = (await observeCapabilities({ repository, registries, session, user: reviewer })).observations[0];
  if (!observation) throw new Error("benchmark capability observation was not created");
  await reviewCapability({ repository, registries, session, user: reviewer, capabilityId: observation.capabilityId, body: {
    observationId: observation.id,
    contractHash: observation.contractHash,
    decisionKey: "local_latency_review_0001",
    effectClass: "read",
    riskClass: "low",
    dataClass: "internal",
    retryPolicy: "never",
    note: "Local injected latency fixture reviewed for repeatable platform measurements",
  } });

  const headers = Array.from({ length: LANES }, (_, lane) => ({ authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { algorithm: "HS256", subject: `bench_${lane}`, expiresIn: 3600 })}` }));
  const draftRevisions = [];
  await repository.mutate(state => {
    for (let lane = 0; lane < LANES; lane++) {
      const owner = { id: `bench_${lane}`, name: `Benchmark ${lane}` };
      for (const profile of ["draft", "run"]) {
        const id = `${profile}-${lane}`;
        const yaml = stringify({ name: `${profile} latency ${lane}`, description: "Local latency fixture", trigger: { type: "manual" }, steps: [
          { id: "one", action: tool.name, parameters: { value: "first" } },
          { id: "two", action: tool.name, parameters: { value: "second" } },
        ] });
        state.workflows[id] = { id, name: `${profile} latency ${lane}`, description: "Local latency fixture", owner, assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 2,
          successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt: now, updatedAt: now, yaml, archived: false };
        state.versions[id] = [];
        if (profile === "draft") draftRevisions[lane] = { version: 1, contentHash: workflowContentHash(yaml) };
      }
    }
  });

  app = await buildApp(services);
  await app.ready();
  for (let lane = 0; lane < LANES; lane++) {
    const response = await app.inject({ method: "POST", url: `/api/workflows/run-${lane}/publish`, headers: headers[lane], payload: {} });
    assertStatus(response, 200, `publish run-${lane}`);
  }

  const hundredNodeYAML = stringify({ name: "100 node validation", description: "Local bounded validation workload", trigger: { type: "manual" }, steps: Array.from({ length: 100 }, (_, index) => ({ id: `node_${index}`, action: tool.name, parameters: { value: String(index) } })) });
  for (let index = 0; index < 5; index++) validateWorkspaceDraft("LatencyWarmup", hundredNodeYAML, "Platform Admin", validator, [tool]);
  const validationSamples = [];
  for (let index = 0; index < LANES * SAMPLES_PER_LANE; index++) {
    const started = performance.now();
    const result = validateWorkspaceDraft(`Latency-${index}`, hundredNodeYAML, "Platform Admin", validator, [tool]);
    validationSamples.push(performance.now() - started);
    if (!result.passed) throw new Error(`100-node validation failed: ${result.errors.join("; ")}`);
  }

  const listSamples = await concurrentRequests(async lane => {
    const started = performance.now();
    const response = await app.inject({ method: "GET", url: "/api/workflows", headers: headers[lane] });
    assertStatus(response, 200, "workflow list");
    return performance.now() - started;
  });

  const draftSamples = [];
  await Promise.all(Array.from({ length: LANES }, async (_, lane) => {
    for (let index = 0; index < WARMUPS_PER_LANE + SAMPLES_PER_LANE; index++) {
      const revision = draftRevisions[lane];
      const started = performance.now();
      const response = await app.inject({ method: "POST", url: `/api/workflows/draft-${lane}/commands`, headers: headers[lane], payload: {
        baseVersion: revision.version,
        baseHash: revision.contentHash,
        command: { type: "updateNode", nodeId: "one", patch: { parameters: { value: `lane-${lane}-revision-${index}` } } },
      } });
      assertStatus(response, 200, `draft save lane ${lane}`);
      const elapsed = performance.now() - started;
      const record = response.json().data;
      revision.version = record.version;
      revision.contentHash = record.contentHash;
      if (index >= WARMUPS_PER_LANE) draftSamples.push(elapsed);
    }
  }));

  const synchronousSamples = [];
  const synchronousIds = [];
  for (let index = 0; index < WARMUPS_PER_LANE + SAMPLES_PER_LANE; index++) {
    const round = await Promise.all(Array.from({ length: LANES }, async (_, lane) => {
      const started = performance.now();
      const response = await app.inject({ method: "POST", url: `/api/workflows/run-${lane}/run`, headers: headers[lane], payload: { input: {} } });
      assertStatus(response, 200, `synchronous run lane ${lane}`);
      return { elapsed: performance.now() - started, id: response.json().data.id, lane };
    }));
    if (index >= WARMUPS_PER_LANE) for (const item of round) { synchronousSamples.push(item.elapsed); synchronousIds.push({ id: item.id, lane: item.lane }); }
  }

  const admissionSamples = [];
  const admitted = [];
  for (let index = 0; index < WARMUPS_PER_LANE + SAMPLES_PER_LANE; index++) {
    const round = await Promise.all(Array.from({ length: LANES }, async (_, lane) => {
      const key = `latency_${lane}_${index}_${Date.now().toString(36)}`.replace(/[^A-Za-z0-9_-]/g, "_").padEnd(16, "0").slice(0, 128);
      const started = performance.now();
      const response = await app.inject({ method: "POST", url: `/api/workflows/run-${lane}/run`, headers: headers[lane], payload: { input: {}, mode: "async-read", idempotencyKey: key } });
      assertStatus(response, 202, `run admission lane ${lane}`);
      return { elapsed: performance.now() - started, id: response.json().data.id, lane };
    }));
    await waitFor(async () => repository.read(state => round.every(item => ["DONE", "FAILED", "CANCELLED", "RECOVERY_REQUIRED"].includes(state.executions[item.id]?.status ?? ""))), WAIT_TIMEOUT_MS);
    if (index >= WARMUPS_PER_LANE) for (const item of round) { admissionSamples.push(item.elapsed); admitted.push({ id: item.id, lane: item.lane }); }
  }

  await waitFor(async () => repository.read(state => admitted.every(item => (state.executionEvents[item.id] ?? []).some(event => event.type === "run.started"))), WAIT_TIMEOUT_MS);
  const acquisitionSamples = await repository.read(state => admitted.map(item => {
    const events = state.executionEvents[item.id] ?? [];
    const queued = events.find(event => event.type === "run.queued");
    const started = events.find(event => event.type === "run.started");
    if (!queued || !started) throw new Error(`worker acquisition evidence missing for ${item.id}`);
    return Math.max(0, Date.parse(started.timestamp) - Date.parse(queued.timestamp));
  }));

  const replaySamples = await concurrentItems(admitted, async item => {
    const started = performance.now();
    const response = await app.inject({ method: "GET", url: `/api/executions/${item.id}/events?after=0&limit=100`, headers: headers[item.lane] });
    assertStatus(response, 200, `event replay ${item.id}`);
    if (!response.json().data.events.length) throw new Error(`event replay was empty for ${item.id}`);
    return performance.now() - started;
  });

  const metrics = [
    evaluateLatencyBudget("draft_save_api", 300, draftSamples),
    evaluateLatencyBudget("run_creation_api", 300, admissionSamples),
    evaluateLatencyBudget("warm_worker_acquisition", 250, acquisitionSamples),
    evaluateLatencyBudget("combined_structural_semantic_validation_100_nodes", 100, validationSamples),
    evaluateLatencyBudget("simple_two_read_fixture_run", 500, synchronousSamples),
    evaluateLatencyBudget("persisted_event_replay_api", 300, replaySamples),
  ];
  const report = {
    profile: "local-orchestration-latency/v1",
    measuredAt: new Date().toISOString(),
    enforced: ENFORCE,
    passed: metrics.every(metric => metric.passed),
    workload: { lanes: LANES, samplesPerLane: SAMPLES_PER_LANE, warmupsPerLane: WARMUPS_PER_LANE, artifactNodes: 100, readNodesPerRun: 2 },
    environment: { node: process.version, platform: `${process.platform}/${process.arch}`, cpuCount: os.cpus().length, cpuModel: os.cpus()[0]?.model ?? "unknown", storage: "in-process memory repository", transport: "injected modern ERPBridge SDK with reviewed immutable capability", externalDelay: "none configured" },
    metrics,
    diagnostics: { authenticatedWorkflowList: summarizeLatency(listSamples), measuredSynchronousRunIds: synchronousIds.length, measuredAsyncRunIds: admitted.length },
    exclusions: [
      "No browser rendering or network socket is included; Fastify inject measures server orchestration.",
      "No live ERPBridge, ERP, model provider, email service, Cloud Firestore or Firebase Hosting latency is included.",
      "Persisted event replay measures the server read path, not commit-to-browser streaming visibility.",
      "Memory storage is a local orchestration baseline, not a cloud database SLO or production certificate.",
    ],
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (ENFORCE && !report.passed) process.exitCode = 1;
} finally {
  if (app) await app.close();
  await session.close();
  await repository.close();
}

function integerSetting(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number.parseInt(raw, 10);
  if (value < minimum || value > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  return value;
}

function assertStatus(response, expected, label) {
  if (response.statusCode !== expected) throw new Error(`${label} returned ${response.statusCode}: ${response.body.slice(0, 500)}`);
}

async function concurrentRequests(operation) {
  const samples = [];
  await Promise.all(Array.from({ length: LANES }, async (_, lane) => {
    for (let index = 0; index < WARMUPS_PER_LANE + SAMPLES_PER_LANE; index++) {
      const value = await operation(lane, index);
      if (index >= WARMUPS_PER_LANE) samples.push(value);
    }
  }));
  return samples;
}

async function concurrentItems(items, operation) {
  const samples = [];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(LANES, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      samples.push(await operation(items[index], index));
    }
  }));
  return samples;
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`latency harness timed out after ${timeoutMs}ms`);
}

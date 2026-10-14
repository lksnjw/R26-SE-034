import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { vi } from "vitest";
import { stringify } from "yaml";
import { loadConfig } from "../../src/config/config.js";
import { Repository, type PersistenceBackend, type RepositoryState } from "../../src/repository/store.js";
import { applyExecutionCheckpoint, type ExecutionCheckpoint } from "../../src/repository/execution-transaction.js";
import { RegistryService } from "../../src/registry/service.js";
import { RegistryValidator } from "../../src/validator/registry-validator.js";
import { Executor } from "../../src/runner/executor.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createErpbridgeMcpSession } from "../../src/tools/erpbridge-mcp-client.js";
import { configureReadTaskDispatch, type ReadTaskCommand, type ReadTaskTransport } from "../../src/runner/read-task-outbox.js";
import { bindExecutionHost } from "../../src/runner/execution-host.js";
import { buildApp } from "../../src/http/app.js";

/** Protocol/fault fixture only. Not proof of encryption or cloud delivery. */
export class TaskRecords implements PersistenceBackend {
  readonly readQueueDurability = "encrypted-single-writer" as const;
  readonly executionCheckpointDurability = "encrypted-record-transactions/v1" as const;
  bytes: Buffer | null = null;
  failWhen: ((state: RepositoryState) => boolean) | undefined;
  commitBeforeFailure = false;
  async load() { return this.bytes; }
  async save(bytes: Uint8Array) {
    if (this.failWhen?.(JSON.parse(Buffer.from(bytes).toString()))) {
      this.failWhen = undefined; if (this.commitBeforeFailure) this.bytes = Buffer.from(bytes); throw new Error("Synthetic acknowledgement lost");
    }
    this.bytes = Buffer.from(bytes);
  }
  async saveExecutionCheckpoint(checkpoint: ExecutionCheckpoint) {
    await this.save(Buffer.from(JSON.stringify(applyExecutionCheckpoint(JSON.parse(this.bytes!.toString()), checkpoint))));
  }
  async probe() {} async close() {}
}

export async function boundedReadFixture(options: { storage?: PersistenceBackend | null; enqueue?: ReadTaskTransport["enqueue"]; timeoutMs?: number; configure?: boolean } = {}) {
  const config = { ...loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "memory", MCP_MODE: "mock", JWT_SECRET: "bounded-read-test-secret-at-least-32-bytes", STORAGE_ENCRYPTION_KEY: "x".repeat(32) }), erpbridgeRoleMap: { "Platform Admin": "admin" } };
  const repository = await Repository.open(options.storage ?? null);
  const registries = await RegistryService.load(resolve("tests/fixtures/chat-read-tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
  const sdk = { connect: vi.fn(async () => {}), close: vi.fn(async () => {}), listTools: vi.fn(async () => registries.snapshot().tools.map(tool => ({ name: tool.mcp_tool_name, inputSchema: tool.input_schema }))),
    callTool: vi.fn(async (): Promise<unknown> => ({ content: [], structuredContent: { value: "acknowledged synthetic read" } })) };
  const bridge = await createErpbridgeMcpSession({ baseURL: "https://task-fixture.example.test", token: "synthetic-stable-credential", timeoutMs: 1000, validator, sdkClient: sdk });
  const services = { config, repository, registries, validator, executor, erpbridgeSession: bridge };
  bindExecutionHost(repository, "bounded-invocation");
  const sent: ReadTaskCommand[] = [], enqueue = vi.fn<ReadTaskTransport["enqueue"]>(options.enqueue ?? (async command => {
    sent.push(structuredClone(command)); return { taskId: command.taskId, outcome: "CREATED" };
  }));
  if (options.configure !== false) configureReadTaskDispatch(repository, { enqueue, timeoutMs: options.timeoutMs ?? 1000 });
  const app = await buildApp(services, { executionHost: "bounded-invocation" });
  const timestamp = new Date().toISOString(), yaml = stringify({ name: "Bounded exact read", description: "Synthetic task fixture", trigger: { type: "manual" }, steps: [
    { id: "first", action: "demo.echo", parameters: { value: "first" } }, { id: "second", action: "demo.echo", parameters: { value: "second" } },
  ] });
  if (!(await repository.read(state => state.users.owner))) await repository.mutate(state => {
    state.users.owner = { id: "owner", name: "Owner", email: "owner@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "O", departmentId: null, lastLoginAt: null, createdAt: timestamp };
    state.workflows.workflow = { id: "workflow", name: "Bounded exact read", description: "Synthetic", owner: { id: "owner", name: "Owner" }, assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 2,
      successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt: timestamp, updatedAt: timestamp, yaml, archived: false };
    state.versions.workflow = [];
  });
  const headers = { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { algorithm: "HS256", subject: "owner", expiresIn: 3600 })}` };
  const publish = () => app.inject({ method: "POST", url: "/api/workflows/workflow/publish", headers, payload: {} });
  const run = (key = "bounded-read-task-fixture-0001") => app.inject({ method: "POST", url: "/api/workflows/workflow/run", headers, payload: { mode: "async-read", idempotencyKey: key, input: {} } });
  const close = async () => { await app.close(); await bridge.close(); await repository.close(); };
  return { repository, services, sdk, app, headers, sent, enqueue, publish, run, close };
}

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { stringify } from "yaml";
import { loadConfig } from "../src/config/config.js";
import { Repository } from "../src/repository/store.js";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.js";
import { RegistryService } from "../src/registry/service.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { bindExecutionHost } from "../src/runner/execution-host.js";
import { configureReadTaskDispatch, recoverReadTaskOutboxes, assertReadTaskOutbox } from "../src/runner/read-task-outbox.js";
import { readJobQueue } from "../src/runner/read-jobs.js";
import { buildApp } from "../src/http/app.js";

// No credentials, remote ERP, model or real task queue. Actual encrypted
// Firestore transactions and exclusive ownership are qualified separately
// from fixture task delivery. Every phase owns and closes a fresh process.
const projectId = "demo-lcwe-records";
if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:23671" || process.env.GCLOUD_PROJECT !== projectId || process.env.GOOGLE_APPLICATION_CREDENTIALS)
  throw new Error("Fixed loopback Firestore emulator, demo project and no credential file are required");
const phase = process.argv[process.argv.indexOf("--phase") + 1];
const phases = new Set(["admit", "execute", "duplicate", "recover", "finish-before", "finish-after",
  ...["PREPARED", "ENQUEUE_INTENT", "ENQUEUED"].flatMap(stage => [`fault-${stage}-before`, `fault-${stage}-after`])]);
const commandFor = job => {
  const record = assertReadTaskOutbox(job);
  return { profile: "read-task-delivery/v1", executionId: job.executionId, taskId: record.taskId };
};

async function child() {
  assert(phases.has(phase), "Unknown qualification phase");
  const workspaceId = process.env.LCWE_TASK_QA_WORKSPACE, key = process.env.LCWE_TASK_QA_KEY;
  assert(/^test_[a-f0-9]{32}_readtask$/.test(workspaceId ?? ""));
  assert.equal(Buffer.from(key ?? "", "base64").length, 32);
  const config = { ...loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "memory", MCP_MODE: "mock",
    JWT_SECRET: "isolated-read-task-emulator-fixture-secret-32-bytes", STORAGE_ENCRYPTION_KEY: key }),
    erpbridgeRoleMap: { "Platform Admin": "admin" }, readWorkerLeaseMs: 5000 };
  const storage = await FirestoreRecordPersistence.open(key, { projectId, databaseId: "(default)", workspaceId });
  const repository = await Repository.open(storage);
  const registries = await RegistryService.load(resolve("tests/fixtures/chat-read-tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
  let sdkCalls = 0;
  const sdk = { connect: async () => {}, close: async () => {},
    listTools: async () => registries.snapshot().tools.map(tool => ({ name: tool.mcp_tool_name, inputSchema: tool.input_schema })),
    callTool: async () => { sdkCalls++; return { content: [], structuredContent: { value: "acknowledged emulator fixture" } }; } };
  const bridge = await createErpbridgeMcpSession({ baseURL: "https://read-task.fixture.example.test", token: "synthetic-stable-credential",
    timeoutMs: 1000, validator, sdkClient: sdk });
  const services = { config, repository, registries, validator, executor, erpbridgeSession: bridge };
  bindExecutionHost(repository, "bounded-invocation");
  const enqueued = [];
  configureReadTaskDispatch(repository, { timeoutMs: 1000, enqueue: async command => {
    enqueued.push(structuredClone(command)); return { taskId: command.taskId, outcome: phase === "recover" ? "ALREADY_EXISTS" : "CREATED" };
  } });
  const app = await buildApp(services, { executionHost: "bounded-invocation" });
  const headers = { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { algorithm: "HS256", subject: "owner", expiresIn: 3600 })}` };
  let injected = false, attemptedCommand;
  const writer = storage.saveExecutionCheckpoint.bind(storage);
  try {
    if (!(await repository.read(state => state.users.owner))) {
      const timestamp = new Date().toISOString(), yaml = stringify({ name: "Firestore bounded task", description: "Synthetic read task",
        trigger: { type: "manual" }, steps: [{ id: "first", action: "demo.echo", parameters: { value: "first" } },
          { id: "second", action: "demo.echo", parameters: { value: "second" } }] });
      await repository.mutate(state => {
        state.users.owner = { id: "owner", name: "Owner", email: "owner@example.test", roleId: "role_admin", permissionOverrides: [],
          status: "Active", initials: "O", departmentId: null, lastLoginAt: null, createdAt: timestamp };
        state.workflows.workflow = { id: "workflow", name: "Firestore bounded task", description: "Synthetic", owner: { id: "owner", name: "Owner" },
          assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 2, successRate: 0, lastRunAt: null,
          publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt: timestamp, updatedAt: timestamp, yaml, archived: false };
        state.versions.workflow = [];
      });
      const published = await app.inject({ method: "POST", url: "/api/workflows/workflow/publish", headers, payload: {} });
      assert.equal(published.statusCode, 200, published.body);
    }
    const fault = phase.startsWith("fault-") ? phase.split("-") : phase.startsWith("finish-") ? ["finish", "FINISHED", phase.split("-")[1]] : null;
    if (fault) storage.saveExecutionCheckpoint = async checkpoint => {
      const matches = fault[0] === "finish" ? checkpoint.job?.state === "FINISHED" : checkpoint.job?.taskDispatchSecret?.state === fault[1];
      if (!injected && matches) {
        injected = true; attemptedCommand = commandFor(checkpoint.job);
        if (fault[2] === "after") await writer(checkpoint);
        throw new Error("Synthetic before/after-COMMIT acknowledgement loss");
      }
      return writer(checkpoint);
    };
    let httpStatus, status, recovery;
    if (phase === "admit" || phase.startsWith("fault-")) {
      const response = await app.inject({ method: "POST", url: "/api/workflows/workflow/run", headers,
        payload: { mode: "async-read", idempotencyKey: "firestore-read-task-qualification-0001", input: {} } });
      httpStatus = response.statusCode;
      assert.equal(httpStatus, phase === "admit" ? 202 : fault[1] === "ENQUEUED" ? 503 : 500, response.body);
      assert.equal(sdkCalls, 0);
    } else if (phase === "recover") {
      recovery = await recoverReadTaskOutboxes(repository);
      assert.equal(sdkCalls, 0);
    } else {
      const job = await repository.readAuthoritative(state => structuredClone(Object.values(state.readJobs)[0]));
      assert(job, "Original read job is required");
      if (job.state === "CLAIMED") {
        const remaining = Date.parse(job.lease.expiresAt) - Date.now();
        assert(remaining <= 5000, "Only the original bounded fixture lease may be awaited");
        if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining + 10));
      }
      if (fault) {
        await assert.rejects(readJobQueue(services).executeTask(commandFor(job), { timeoutMs: 4000 }));
      } else {
        const run = await readJobQueue(services).executeTask(commandFor(job), { timeoutMs: 4000 });
        status = run.status; assert.equal(status, "DONE");
        assert.deepEqual(run.stepOutputs.first.structuredContent, { value: "acknowledged emulator fixture" });
        assert.deepEqual(run.stepOutputs.second.structuredContent, { value: "acknowledged emulator fixture" });
      }
    }
    if (fault) { assert(injected); assert.throws(() => repository.assertAuthority()); }
    const jobs = Object.values((await repository.snapshot()).readJobs);
    assert(jobs.length <= 1, "Never manufacture a second admission");
    return { pid: process.pid, sdkCalls, enqueued, httpStatus, status, recovery, injected,
      command: attemptedCommand ?? (jobs[0] ? commandFor(jobs[0]) : null), jobs: jobs.length };
  } finally {
    storage.saveExecutionCheckpoint = writer;
    await app.close(); await bridge.close(); await repository.close();
  }
}

if (process.argv.includes("--phase")) {
  console.log(JSON.stringify(await child()));
} else {
  const launch = promisify(execFile), script = fileURLToPath(import.meta.url);
  const namespace = () => ({ LCWE_TASK_QA_WORKSPACE: `test_${randomUUID().replaceAll("-", "")}_readtask`, LCWE_TASK_QA_KEY: randomBytes(32).toString("base64") });
  const invoke = async (phase, fixture) => {
    const { stdout } = await launch(process.execPath, ["--import", "tsx/esm", script, "--phase", phase], {
      cwd: process.cwd(), env: { ...process.env, ...fixture, NODE_ENV: "test" }, timeout: 45_000, maxBuffer: 256_000, windowsHide: true,
    });
    return JSON.parse(stdout.trim());
  };
  const fixture = namespace(), admitted = await invoke("admit", fixture), executed = await invoke("execute", fixture), duplicate = await invoke("duplicate", fixture);
  assert.equal(new Set([admitted.pid, executed.pid, duplicate.pid]).size, 3);
  assert.deepEqual(executed.command, admitted.command); assert.deepEqual(duplicate.command, admitted.command);
  assert.equal(executed.sdkCalls, 2); assert.equal(duplicate.sdkCalls, 0); assert.equal(duplicate.jobs, 1);
  console.log("PASS: actual encrypted Firestore admission, execution and duplicate delivery across three distinct cleanly closed processes; two fixture ERP calls, no replay");
  for (const stage of ["PREPARED", "ENQUEUE_INTENT", "ENQUEUED"]) for (const edge of ["before", "after"]) {
    const fixture = namespace(), failed = await invoke(`fault-${stage}-${edge}`, fixture), recovered = await invoke("recover", fixture);
    const absent = stage === "PREPARED" && edge === "before";
    assert.equal(recovered.jobs, absent ? 0 : 1); assert.equal(failed.sdkCalls + recovered.sdkCalls, 0);
    assert.equal(failed.enqueued.length, stage === "ENQUEUED" ? 1 : 0);
    assert.equal(recovered.enqueued.length, absent || stage === "ENQUEUED" && edge === "after" ? 0 : 1);
    if (!absent) {
      assert.deepEqual(recovered.command, failed.command);
      const executed = await invoke("execute", fixture), duplicate = await invoke("duplicate", fixture);
      assert.deepEqual(executed.command, failed.command); assert.equal(executed.sdkCalls, 2); assert.equal(duplicate.sdkCalls, 0);
    }
    console.log(`PASS: ${edge}-COMMIT ${stage} ACK loss; new-process authoritative recovery retained the original task identity, with no ERP call during dispatch recovery`);
  }
  for (const edge of ["before", "after"]) {
    const fixture = namespace(), admitted = await invoke("admit", fixture), failed = await invoke(`finish-${edge}`, fixture), duplicate = await invoke("duplicate", fixture);
    assert.deepEqual(failed.command, admitted.command); assert.deepEqual(duplicate.command, admitted.command);
    assert.equal(failed.sdkCalls, 2); assert.equal(duplicate.sdkCalls, 0); assert.equal(duplicate.status, "DONE");
    console.log(`PASS: ${edge}-COMMIT job-finish ACK loss; new-process delivery reconciled confirmed DONE evidence without repeating either fixture ERP call`);
  }
  console.log("PASS: read task campaign complete; task transport and ERP are fixtures, clean process restarts only, no Firebase Functions/cloud/killed-process qualification");
}

import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { afterEach, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { buildApp } from "../src/http/app.js";
import { Repository, type Execution } from "../src/repository/store.js";
import { RegistryService } from "../src/registry/service.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { bindExecutionHost, residentExecutionAllowed, requireResidentExecution } from "../src/runner/execution-host.js";
import { chatJobQueue } from "../src/agent/chat-jobs.js";
import { readJobQueue } from "../src/runner/read-jobs.js";
import { operationJobQueue } from "../src/runner/operation-jobs.js";
import { operationReadbackQueue } from "../src/runner/operation-readback-jobs.js";
import { saveWorkflowSchedule, workflowScheduleRunner } from "../src/runner/workflow-schedules.js";
import { admitEmailDelivery } from "../src/delivery/email-operation.js";
import { admitOperationRecovery } from "../src/runner/operation-recovery-artifacts.js";
import { admitProtectedOperation } from "../src/runner/protected-job-admission.js";
import { decideRuntimeApproval } from "../src/runner/runtime-approvals.js";
import { resolveReportPage } from "../src/runner/report-page-resolution.js";

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { await Promise.all(closers.splice(0).reverse().map(close => close())); vi.restoreAllMocks(); });
const hostFailure = { status: 503, meta: { code: "EXECUTION_HOST_DISPATCH_UNAVAILABLE" } };

async function setup(mode: "resident-server" | "bounded-invocation" = "bounded-invocation") {
  const config = loadConfig({ APP_ENV: "test", MCP_MODE: "mock", STORAGE_DRIVER: "memory", JWT_SECRET: "execution-host-test-secret-32-bytes" });
  const repository = await Repository.open(null); closers.push(() => repository.close());
  await repository.mutate(state => {
    state.users.owner = { id: "owner", name: "Owner", email: "owner@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "O", departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() };
    state.chats.chat = { id: "chat", ownerId: "owner", title: "Saved", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messageCount: 0, messages: [] };
  });
  bindExecutionHost(repository, mode);
  const registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
  const services = { config, repository, registries, validator, executor };
  const app = await buildApp(services); closers.push(() => app.close());
  const actor = (await repository.effectiveUser("owner"))!;
  const headers = { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { algorithm: "HS256", subject: actor.id, expiresIn: 3600 })}` };
  return { services, repository, app, actor, headers };
}

test("host binding is immutable, local to the owned repository and never persisted", async () => {
  const a = await Repository.open(null), b = await Repository.open(null);
  closers.push(() => a.close(), () => b.close());
  const before = await a.snapshot();
  expect(bindExecutionHost(a, "bounded-invocation")).toBe("bounded-invocation");
  expect(bindExecutionHost(a)).toBe("bounded-invocation");
  expect(residentExecutionAllowed(a)).toBe(false);
  expect(() => bindExecutionHost(a, "resident-server")).toThrow("cannot change");
  expect(bindExecutionHost(b)).toBe("resident-server");
  expect(() => bindExecutionHost(b, "bounded-invocation")).toThrow("cannot change");
  expect(await a.snapshot()).toEqual(before);
  expect(() => requireResidentExecution(a)).toThrow("No new job or continuation");
  expect(() => requireResidentExecution(b)).not.toThrow();
});

test.each([null, "unknown", {}, false])("invalid host policy %j fails rather than defaulting to resident", async value => {
  const repository = await Repository.open(null); closers.push(() => repository.close());
  expect(() => bindExecutionHost(repository, value as never)).toThrow("Unsupported execution host");
  expect(bindExecutionHost(repository, "bounded-invocation")).toBe("bounded-invocation");
});

test("queue construction binds the default host before a later HTTP host can change it", async () => {
  const { services } = await setup("resident-server");
  chatJobQueue(services);
  await expect(buildApp(services, { executionHost: "bounded-invocation" })).rejects.toThrow("cannot change");
});

test("bounded app readiness and queue kicks cannot start worker pumps or mutate the repository", async () => {
  const { services, repository, app } = await setup();
  const queues = [chatJobQueue(services), readJobQueue(services), operationJobQueue(services), operationReadbackQueue(services), workflowScheduleRunner(services)];
  const starts = queues.map(queue => vi.spyOn(queue, "start"));
  const before = await repository.snapshot(), authoritative = vi.spyOn(repository, "readAuthoritative"), writes = vi.spyOn(repository, "mutate");
  await app.ready();
  for (const start of starts) expect(start).not.toHaveBeenCalled();
  for (const queue of queues) { await expect(queue.start()).rejects.toMatchObject(hostFailure); queue.kick(); }
  await new Promise<void>(done => setImmediate(done));
  await new Promise<void>(done => setImmediate(done));
  expect(authoritative).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
  expect(await repository.snapshot()).toEqual(before);
  const read = readJobQueue(services);
  expect(() => read.assertCapacity(before)).toThrow("Durable task dispatch");
  expect(() => read.store(before, {} as Execution, {} as never)).toThrow("Durable task dispatch");
  await expect(workflowScheduleRunner(services).runDue()).rejects.toMatchObject(hostFailure);
});

test("resident app still explicitly starts all five workers", async () => {
  const { services, app } = await setup("resident-server");
  const queues = [chatJobQueue(services), readJobQueue(services), operationJobQueue(services), operationReadbackQueue(services), workflowScheduleRunner(services)];
  const starts = queues.map(queue => vi.spyOn(queue, "start"));
  await app.ready();
  for (const start of starts) expect(start).toHaveBeenCalledTimes(1);
});

test("bounded async chat returns an actionable failure without messages, jobs or authority side effects", async () => {
  const { app, repository, headers } = await setup();
  const before = await repository.snapshot();
  const response = await app.inject({ method: "POST", url: "/api/chat/sessions/chat/messages", headers,
    payload: { content: "Read invoices", delivery: "async-chat", idempotencyKey: "bounded-chat-fixture-00001", executionHost: "resident-server" } });
  expect(response.statusCode).toBe(503);
  expect(response.json().meta).toMatchObject(hostFailure.meta);
  expect(await repository.snapshot()).toEqual(before);
  const saved = await app.inject({ method: "GET", url: "/api/chat/sessions/chat", headers });
  expect(saved.statusCode).toBe(200); expect(saved.json().data.messages).toEqual([]);
});

test("bounded host still authenticates and authorizes before exposing execution errors", async () => {
  const { app } = await setup();
  const response = await app.inject({ method: "POST", url: "/api/chat/sessions/chat/messages", payload: { delivery: "async-chat", content: "Read invoices" } });
  expect(response.statusCode).toBe(401);
});

test("every alternate admission and resumable command is denied before state changes", async () => {
  const { services, actor, repository } = await setup(), before = await repository.snapshot();
  const commands = [
    () => chatJobQueue(services).admit("chat", actor, {}, "fixture"),
    () => operationJobQueue(services).admit({} as never, {}, actor, "fixture", "fixture"),
    () => operationReadbackQueue(services).admit("run", actor, {}),
    () => admitEmailDelivery(services, actor, "chat", {}, "fixture", {} as never),
    () => admitOperationRecovery(services, "run", "artifact", actor, {}, "fixture"),
    () => admitProtectedOperation(services, "workflow", actor, {}, "fixture"),
    () => decideRuntimeApproval(repository, "run", actor, {}, "APPROVED"),
  ];
  for (const command of commands) await expect(command()).rejects.toMatchObject(hostFailure);
  // PAGE_CONFIRMED can create a continuation; abandonment and rejection remain
  // separately governed non-dispatching operations, not silently auto-enabled.
  await expect(resolveReportPage(repository, "run", actor, { outcome: "PAGE_CONFIRMED" })).rejects.toMatchObject(hostFailure);
  expect(await repository.snapshot()).toEqual(before);
});

test("bounded schedule activation cannot promise an occurrence without a task dispatcher", async () => {
  const { services, actor, repository } = await setup(), before = await repository.snapshot();
  await expect(saveWorkflowSchedule(services, "workflow", actor, {
    profile: "workflow-daily-schedule-command/v1", enabled: true, baseRevision: 0, workflowVersion: 1,
    workflowHash: `sha256:${"a".repeat(64)}`, timezone: "Asia/Colombo", localTime: "09:00", reportingPeriod: "previous-calendar-day",
    misfirePolicy: "SKIP", misfireGraceSeconds: 60, servicePrincipalId: actor.id, input: {},
    reportWindowBinding: { profile: "workflow-report-window-input-binding/v1", startAtInput: "start", endAtInput: "end" },
  })).rejects.toMatchObject(hostFailure);
  expect(await repository.snapshot()).toEqual(before);
});

test("repository copies and request payloads cannot overwrite a bounded policy", async () => {
  const { services } = await setup();
  const fakeServices = { ...services, executionHost: "resident-server" };
  await expect(chatJobQueue(fakeServices).admit("chat", {} as never, { executionHost: "resident-server" }, "fixture")).rejects.toMatchObject(hostFailure);
  expect(bindExecutionHost(services.repository)).toBe("bounded-invocation");
});

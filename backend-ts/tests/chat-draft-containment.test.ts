import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { afterEach, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { buildApp } from "../src/http/app.js";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { SynthesisService } from "../src/synthesis/service.js";
import { RegistryService } from "../src/registry/service.js";
import { Repository } from "../src/repository/store.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { Executor } from "../src/runner/executor.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
const yaml = "name: Echo\ndescription: Echo a value\ntrigger:\n  type: manual\nsteps:\n - id: read\n   action: demo.echo\n   parameters:\n     value: hello\n";
async function setup(response = yaml, roleId = "role_admin") {
  const config = loadConfig({ APP_ENV: "test", JWT_SECRET: "test-chat-draft-secret-at-least-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "mock" });
  const repository = new Repository(null);
  await repository.mutate((state) => { state.users.user = { id: "user", name: "User", email: "user@example.test", roleId, permissionOverrides: [], status: "Active", initials: "U", departmentId: null, lastLoginAt: null, createdAt: new Date().toISOString() }; });
  const registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, repository);
  const executor = new Executor(new ToolRegistry(), validator);
  const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: response } }], usage: { prompt_tokens: 5, completion_tokens: 7 } }));
  const providerRuntime = new ProviderRuntime(repository, executor, fetchImplementation);
  providerRuntime.activate({ id: "test", name: "Test", type: "openai_compatible", baseURL: "https://provider.example.test/v1", apiKey: "test", model: "test-v1", temperature: 0, timeoutMs: 1000,
    egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://provider.example.test", runtimeAnalysisDataClasses: [], interactiveDataClasses: ["restricted"], reviewedAt: "2026-10-07T00:00:00.000Z", reviewedBy: { id: "user", name: "User" } } });
  const app = await buildApp({ config, repository, registries, validator, executor, providerRuntime, synthesis: new SynthesisService(providerRuntime, registries, validator) });
  apps.push(app);
  const headers = { authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { algorithm: "HS256", subject: "user", expiresIn: 3600 })}` };
  const chat = await app.inject({ method: "POST", url: "/api/chat/sessions", headers, payload: {} });
  expect(chat.statusCode).toBe(201);
  const send = (content: string) => app.inject({ method: "POST", url: `/api/chat/sessions/${chat.json().data.id}/messages`, headers, payload: { content } });
  return { app, repository, fetchImplementation, send, headers };
}

test("generation saves an acknowledged draft without publishing, executing or spending a narrative call", async () => {
  const s = await setup();
  const response = await s.send("Create a workflow to echo hello");
  expect(response.statusCode, response.body).toBe(200);
  const data = response.json().data;
  expect(data.assistantMessage.artifacts).toMatchObject({ can_execute: false, validation_passed: true, next_action: "REVIEW_DRAFT" });
  expect(data.answer).toContain("has not been published or executed");
  const state = await s.repository.snapshot();
  expect(Object.values(state.workflows)[0]).toMatchObject({ yaml: yaml.trim(), publishedVersion: 0, draftVersion: 1, canRun: false });
  expect(state.executions).toEqual({});
  expect(s.fetchImplementation).toHaveBeenCalledTimes(1);
});

test("unknown actions remain in the original blocked proposal, never silently removed", async () => {
  const proposed = yaml + " - id: missing\n   action: unknown.delivery\n";
  const s = await setup(proposed);
  const response = await s.send("Create a workflow to read then deliver a report");
  expect(response.statusCode, response.body).toBe(200);
  const data = response.json().data;
  expect(data.yaml).toBe(proposed.trim());
  expect(data.validation.passed).toBe(false);
  expect(data.assistantMessage.artifacts.missing_tools).toContain("unknown.delivery");
  expect(Object.values((await s.repository.snapshot()).workflows)[0]?.yaml).toContain("unknown.delivery");
});

test("an explicitly incomplete requested outcome remains in a blocked saved draft and cannot publish or run", async () => {
  const proposed = yaml + "metadata:\n  unresolved_requirements:\n   - Manager delivery connector is unavailable\n";
  const s = await setup(proposed);
  const response = await s.send("Create a workflow to read and deliver invoices to the manager");
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.validation.failed_rules).toContain("UNRESOLVED_REQUIREMENTS");
  expect(response.json().data.assistantMessage.artifacts.can_execute).toBe(false);
  const draft = Object.values((await s.repository.snapshot()).workflows)[0]!;
  expect(draft.yaml).toBe(proposed.trim()); expect(draft.publishedVersion).toBe(0);
  const publish = await s.app.inject({ method: "POST", url: `/api/workflows/${draft.id}/publish`, headers: s.headers, payload: {} });
  expect(publish.statusCode, publish.body).toBe(422);
  const run = await s.app.inject({ method: "POST", url: `/api/workflows/${draft.id}/run`, headers: s.headers, payload: {} });
  expect(run.statusCode, run.body).toBe(422);
  expect((await s.repository.snapshot()).executions).toEqual({});
  expect(s.fetchImplementation).toHaveBeenCalledTimes(1);
});

test("chat-only user cannot acquire workflow write authority through autosave", async () => {
  const s = await setup(yaml, "role_client");
  const response = await s.send("Create a workflow to echo hello");
  expect(response.statusCode, response.body).toBe(200);
  expect((await s.repository.snapshot()).workflows).toEqual({});
  expect(response.json().data.answer).toContain("no saved draft was acknowledged");
});

test("offline ERP query returns a durable precise failure without asking a model to invent data", async () => {
  const s = await setup();
  const response = await s.send("List daily invoices");
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.operation).toEqual({ success: false, code: "ERPBRIDGE_NOT_CONNECTED" });
  expect(response.json().data.answer).toContain("No ERP operation was performed");
  expect(s.fetchImplementation).not.toHaveBeenCalled();
  expect(Object.values((await s.repository.snapshot()).chats)[0]?.messages).toHaveLength(2);
});

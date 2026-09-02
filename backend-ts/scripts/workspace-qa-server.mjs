// Opt-in LOCAL UI fixture only. No env file, remote provider, persistence or ERP.
// Run from backend-ts: node --import tsx/esm scripts/workspace-qa-server.mjs
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { loadConfig } from "../src/config/config.ts";
import { buildApp } from "../src/http/app.ts";
import { Repository } from "../src/repository/store.ts";
import { RegistryService } from "../src/registry/service.ts";
import { RegistryValidator } from "../src/validator/registry-validator.ts";
import { Executor } from "../src/runner/executor.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { ProviderRuntime } from "../src/providers/runtime.ts";
import { hashPassword } from "../src/authn/password.ts";
import { newReadProgress, appendExecutionEvent } from "../src/runner/read-checkpoints.ts";

const config = loadConfig({ APP_ENV: "test", JWT_SECRET: "local-workspace-qa-only-not-production-secret", STORAGE_DRIVER: "memory", MCP_MODE: "mock", CORS_ORIGINS: "http://localhost:5173" });
const repository = new Repository(null);
const createdAt = new Date().toISOString();
const yaml = stringify({ name: "Daily invoice review", description: "LOCAL fixture only — no real ERP data", trigger: { type: "manual" }, steps: [
  { id: "invoices", action: "demo.echo", description: "Read invoice fixture", parameters: { value: "local invoices" } },
  { id: "summary", action: "demo.echo", description: "Prepare report fixture", parameters: { value: "{{invoices.structuredContent}}" } },
] });
const passwordHash = await hashPassword("Local-QA-only-2026!");
await repository.mutate((state) => {
  state.users.qa = { id: "qa", name: "Local QA", email: "qa@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "QA", departmentId: null, createdAt, lastLoginAt: null };
  state.passwordHashes.qa = passwordHash;
  state.workflows.qa_report = { id: "qa_report", name: "Daily invoice review", description: "Local fixture only", owner: { id: "qa", name: "Local QA" }, assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 2, successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt, updatedAt: createdAt, yaml, archived: false };
  state.versions.qa_report = [{ version: 1, artifactState: "DRAFT", yaml }];
  // Synthetic historical display evidence only, not a dispatched ERP execution.
  state.executions.qa_display_fixture = { id: "qa_display_fixture", workflowId: "qa_report", workflowName: "Daily invoice review", status: "FAILED", startedAt: createdAt, completedAt: createdAt, durationMs: 0, tokens: { input: 0, output: 0, total: 0 }, costUsd: 0, startedBy: { id: "qa", name: "Local QA" }, workflowSnapshot: { version: 1, contentHash: `sha256:${createHash("sha256").update(yaml).digest("hex")}`, registryHash: "synthetic-display-only", yaml, input: {}, executionProfile: "sequential-read-v1" }, agentSummary: "Synthetic display fixture only. No ERP tools were called.", stepOutputs: { invoices: { structuredContent: [{ invoice_id: "FIXTURE-001", customer: "Example Company", total: 12500, currency: "LKR", paid: false }, { invoice_id: "FIXTURE-002", customer: "Demo Customer", total: 3200, currency: "LKR", paid: true }], content: [{ type: "text", text: "Synthetic fixture data — not retrieved from ERP." }] } } };
  state.timelines.qa_display_fixture = [{ nodeId: "invoices", status: "DONE", startedAt: createdAt, completedAt: createdAt }, { nodeId: "summary", status: "FAILED", startedAt: createdAt, completedAt: createdAt }];
  // Optional synthetic read-state UI fixtures. They do not run a worker or SDK;
  // RUNNING intentionally stays pending to check cancellation-request wording.
  if (["running", "recovery"].includes(process.env.WORKSPACE_QA_READ_STATE)) {
    const item = state.executions.qa_display_fixture;
    item.status = process.env.WORKSPACE_QA_READ_STATE === "running" ? "RUNNING" : "RECOVERY_REQUIRED";
    item.readProgress = newReadProgress(repository);
    item.readProgress.nextStepIndex = 1;
    state.executionEvents[item.id] = [];
    state.timelines[item.id][1].status = item.status === "RUNNING" ? "RUNNING" : "UNKNOWN";
    state.timelines[item.id][1].phase = "DISPATCH_INTENT";
    item.readProgress.attempts = { invoices: { id: "fixture-invoices", nodeId: "invoices", stepIndex: 0, status: "DONE", startedAt: createdAt, completedAt: createdAt }, summary: { id: "fixture-summary", nodeId: "summary", stepIndex: 1, status: item.status === "RUNNING" ? "DISPATCH_INTENT" : "UNKNOWN", startedAt: createdAt, dispatchIntentAt: createdAt } };
    if (item.status === "RUNNING") item.completedAt = null;
    else item.failure = { failureCategory: "READ_OUTCOME_UNKNOWN", failedStepId: "summary" };
    appendExecutionEvent(state, item, "run.started", { syntheticFixture: true });
    appendExecutionEvent(state, item, "node.completed", { syntheticFixture: true, outputRef: "invoices" }, "invoices", "fixture-invoices");
    appendExecutionEvent(state, item, item.status === "RUNNING" ? "node.dispatch_intent" : "node.outcome_unknown", { syntheticFixture: true }, "summary", "fixture-summary");
  }
  state.chats.qa_chat = { id: "qa_chat", ownerId: "qa", title: "Local invoice workspace", createdAt, updatedAt: createdAt, messageCount: 2, messages: [
    { id: "qa_request", role: "user", text: "Prepare an invoice review workflow (local fixture).", createdAt },
    { id: "qa_answer", role: "assistant", text: "Local fixture draft saved. ERP connection is intentionally unavailable; no invoices have been retrieved or sent.", createdAt, artifacts: { intent: "WORKFLOW", workflowId: "qa_report", yaml, selected_workflow_yaml: yaml, validation: { passed: true }, validation_passed: true, can_execute: false } },
  ] };
});
const registries = await RegistryService.load(resolve("tests/fixtures/chat-read-tools.json"), resolve("tests/fixtures/rules.json"));
const validator = new RegistryValidator(registries, repository);
const executor = new Executor(new ToolRegistry(), validator);
const providerRuntime = new ProviderRuntime(repository, executor, async () => Response.json({ choices: [{ message: { content: JSON.stringify({ description: "Invoice step reviewed by local fixture agent" }) } }] }));
providerRuntime.activate({ id: "qa-fixture", name: "Local fixture", type: "openai_compatible", baseURL: "https://fixture.invalid/v1", apiKey: "fixture-no-network", model: "fixture-only", temperature: 0, timeoutMs: 1000 });
const app = await buildApp({ config, repository, registries, validator, executor, providerRuntime });
await app.listen({ host: "127.0.0.1", port: 8081 });
console.log("LOCAL UI fixture at 127.0.0.1:8081; qa@example.test / Local-QA-only-2026!; memory-only; no ERP/provider network.");

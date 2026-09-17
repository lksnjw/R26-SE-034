// Explicit LOCAL workspace against the isolated Docker MockERP stack.
// Separate port/account/memory state; no production registry or real model.
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { readQaBridgeToken, qaBaseURL } from "./erpbridge-docker-qa.mjs";
import { qaReviewedDefinition } from "./qualify-erpbridge-qa-read.mjs";
import { loadConfig } from "../src/config/config.ts";
import { Repository } from "../src/repository/store.ts";
import { RegistryService } from "../src/registry/service.ts";
import { RegistryValidator } from "../src/validator/registry-validator.ts";
import { McpConnectionManager } from "../src/tools/mcp-connection-runtime.ts";
import { observeCapabilities, reviewCapability } from "../src/registry/capability-admission.ts";
import { Executor } from "../src/runner/executor.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import { ProviderRuntime } from "../src/providers/runtime.ts";
import { hashPassword } from "../src/authn/password.ts";
import { buildApp } from "../src/http/app.ts";
import { compileReadWorkflow } from "../src/workflows/compiled-read.ts";

export function qaWorkflowBlueprint() {
  const schema = { type: "array", items: { type: "object" } }, sequence = (...nodes) => ({ kind: "sequence", nodes });
  return { name: "LOCAL Docker Department decision", description: "Synthetic Department read through ERPBridge, only on the selected Yes path. No production data or email.",
    trigger: { type: "manual", config: { inputSchema: { type: "object", properties: { includeDepartments: { type: "boolean" } }, required: ["includeDepartments"], additionalProperties: false } } },
    steps: [{ id: "departments", action: "qa_list_departments", description: "Read synthetic Departments · Docker ERPBridge", parameters: {} }],
    metadata: { controlFlow: { schemaVersion: "read-control-flow/v2", root: sequence(
      { kind: "if", id: "include_departments", predicate: { kind: "ref", source: "workflowInput", path: ["includeDepartments"] }, then: sequence({ kind: "action", nodeId: "departments" }), else: sequence(),
        merge: { schema, then: { kind: "ref", source: "nodeOutput", nodeId: "departments", path: ["structuredContent", "data"] }, else: { kind: "array", items: [] } } },
      { kind: "return", id: "answer", output: { schema, value: { kind: "ref", source: "nodeOutput", nodeId: "include_departments", path: ["value"] } } },
    ) } } };
}

export function qaPlanningResponse(request) {
  // This injected fetch never reaches an external provider. The real broker
  // still validates every call against the reviewed Docker tool and actor.
  const system = request.messages?.find(message => message.role === "system")?.content ?? "";
  if (system.includes("ONE SELECTED NODE PATCH")) return { choices: [{ message: { content: '{"description":"Synthetic Departments reviewed in the local Docker workspace"}' } }] };
  const latest = request.messages?.findLast(message => message.role === "user");
  let currentRequest;
  try { currentRequest = JSON.parse(latest?.content ?? "").USER_REQUEST; } catch { /* Not the supported interactive request envelope. */ }
  if (currentRequest !== "List the synthetic Departments from ERPBridge.") throw new Error("LOCAL planning fixture supports only the literal synthetic Department request; no real model is configured");
  const completed = request.messages?.some(message => message.role === "tool" && message.tool_call_id === "local-department-read");
  if (request.tools?.some(tool => tool.function?.name === "qa_list_departments") && !completed)
    return { choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "local-department-read", type: "function", function: { name: "qa_list_departments", arguments: "{}" } }] } }] };
  if (completed) return { choices: [{ finish_reason: "stop", message: { content: "LOCAL planning fixture: the synthetic Department rows were retrieved through Docker ERPBridge. Inspect the saved tool answer for the actual data. No production records or emails were changed." } }] };
  throw new Error("LOCAL planning fixture supports only the explicit Department read and descriptive action-node edit; no real model is configured");
}

export function qaProviderConfiguration(createdAt) {
  return { id: "local-planning-fixture", name: "LOCAL planning fixture · no real model", type: "openai_compatible", baseURL: "https://fixture.invalid/v1", apiKey: "fixture-only-no-network", model: "local-planning-fixture", temperature: 0, timeoutMs: 1000,
    egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://fixture.invalid", runtimeAnalysisDataClasses: [], runtimeAgentDataClasses: [], interactiveDataClasses: ["restricted"], reviewedAt: createdAt, reviewedBy: { id: "qa", name: "LOCAL synthetic-only fixture review" } } };
}

export async function createQaWorkspace() {
  const token = await readQaBridgeToken();
  const response = await fetch(`${qaBaseURL}/apis/erpbridge.io/v1/tools?name=qa_list_departments&version=1.0.0`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("Register the fixed synthetic Department resource before starting this workspace");
  const resources = await response.json();
  if (!Array.isArray(resources) || resources.length !== 1) throw new Error("Expected one exact synthetic resource");
  const definition = qaReviewedDefinition(resources[0]), directory = await mkdtemp(resolve(tmpdir(), "lcwe-docker-workspace-"));
  const files = [resolve(directory, "tools.json"), resolve(directory, "rules.json")], repository = new Repository(null);
  let runtime, app;
  try {
    await writeFile(files[0], JSON.stringify([definition]), { flag: "wx" }); await writeFile(files[1], "[]", { flag: "wx" });
    const registries = await RegistryService.load(...files), validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
    const config = loadConfig({ APP_ENV: "development", PORT: "8082", JWT_SECRET: randomBytes(48).toString("hex"), STORAGE_DRIVER: "memory", MCP_MODE: "remote", MCP_TRANSPORT: "erpbridge-mcp",
      ERPBRIDGE_BASE_URL: qaBaseURL, ERPBRIDGE_MCP_TOKEN: token, ERPBRIDGE_ROLE_MAP: '{"Platform Admin":"admin"}', CORS_ORIGINS: "http://127.0.0.1:5174,http://localhost:5174" });
    const createdAt = new Date().toISOString(), yaml = stringify(qaWorkflowBlueprint()), passwordHash = await hashPassword("Local-QA-only-2026!");
    compileReadWorkflow(yaml, [definition], "Platform Admin");
    const validation = await validator.validateAndIssueToken("qa_departments", yaml, "Platform Admin");
    if (!validation.result.passed) throw new Error("Local decision draft did not pass validation");
    await repository.mutate(state => {
      state.users.qa = { id: "qa", name: "LOCAL Docker QA", email: "qa@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "QA", departmentId: null, createdAt, lastLoginAt: null };
      state.passwordHashes.qa = passwordHash;
      state.workflows.qa_departments = { id: "qa_departments", name: qaWorkflowBlueprint().name, description: "LOCAL MockERP read only · memory state · no real model", owner: { id: "qa", name: "LOCAL Docker QA" }, assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 1, successRate: 0, lastRunAt: null, publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt, updatedAt: createdAt, yaml, archived: false };
      state.versions.qa_departments = [{ version: 1, artifactState: "DRAFT", yaml }];
      state.chats.qa_chat = { id: "qa_chat", ownerId: "qa", title: "LOCAL Docker Department workspace", createdAt, updatedAt: createdAt, messageCount: 2, messages: [
        { id: "qa_request", role: "user", text: "Review the synthetic Department decision workflow in the Docker QA workspace.", createdAt },
        { id: "qa_answer", role: "assistant", text: "LOCAL QA: Docker ERPBridge is configured for one reviewed synthetic GET. This workflow is an unpublished draft. The planning model is an in-process fixture; data comes from real Docker MockERP. Publish and run explicitly. Memory state is lost on restart; no production records or email are supported.", createdAt, artifacts: { intent: "WORKFLOW", workflowId: "qa_departments", yaml, validation_passed: true, can_execute: false } },
      ] };
    });
    runtime = await McpConnectionManager.open({ repository, registries, validator, config });
    const user = await repository.effectiveUser("qa"), status = await runtime.status(user);
    await runtime.command("connect", user, { baseRevision: status.connections[0].revision, requestId: "explicit-local-workspace-connect" });
    const observed = await observeCapabilities({ repository, registries, session: runtime.session, user }), observation = observed.observations[0];
    await reviewCapability({ repository, registries, session: runtime.session, user, capabilityId: observation.capabilityId, body: {
      observationId: observation.id, contractHash: observation.contractHash, decisionKey: "explicit-local-workspace-read-review", effectClass: "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Operator-started LOCAL literal Department GET review; no product registry admission" } });
    const providerRuntime = new ProviderRuntime(repository, executor, async (url, init) => {
      if (String(url) !== "https://fixture.invalid/v1/chat/completions") throw new Error("Local fixture cannot contact another provider");
      return Response.json(qaPlanningResponse(JSON.parse(String(init.body))));
    });
    providerRuntime.activate(qaProviderConfiguration(createdAt));
    const services = { config, repository, registries, validator, executor, providerRuntime, mcpConnectionRuntime: runtime, get erpbridgeSession() { return runtime.session; } };
    app = await buildApp(services);
    const close = async () => { await app.close(); await runtime.stop(); await repository.close(); for (const file of files) await unlink(file); await rmdir(directory); };
    return { app, repository, services, close };
  } catch (error) {
    await app?.close(); await runtime?.stop(); await repository.close();
    for (const file of files) await unlink(file).catch(cause => { if (cause.code !== "ENOENT") throw cause; }); await rmdir(directory);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || process.argv[2] !== "--serve-reviewed-read") { console.error("Use --serve-reviewed-read to start the isolated Docker QA workspace, not production"); process.exitCode = 1; }
  else try {
    const workspace = await createQaWorkspace();
    try { await workspace.app.listen({ host: "127.0.0.1", port: 8082 }); }
    catch (error) { await workspace.close(); throw error; }
    console.log("LOCAL Docker QA backend 127.0.0.1:8082 · qa@example.test / Local-QA-only-2026! · memory only · planning fixture, not a real model. Existing 8081 workspace unchanged.");
    let stopping; for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { stopping ??= workspace.close(); stopping.catch(() => { process.exitCode = 1; }); });
  } catch { console.error("Docker workspace startup was not confirmed; check the exact isolated QA stack. Credentials suppressed."); process.exitCode = 1; }
}

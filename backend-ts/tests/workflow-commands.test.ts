import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { afterEach, expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { loadConfig } from "../src/config/config.js";
import { buildApp } from "../src/http/app.js";
import { Repository } from "../src/repository/store.js";
import { RegistryService } from "../src/registry/service.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { workflowContentHash, parseWorkflowYAMLStrict } from "../src/parser/workflow.js";
import type { Workflow } from "../src/models/schemas.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
const blueprint = { name: "Report", description: "Read report", trigger: { type: "manual" }, steps: [
  { id: "first", action: "demo.echo", parameters: { value: "original" }, condition: "{{input.enabled}}" },
  { id: "approval", kind: "approval", description: "Approve any transaction separately" },
  { id: "last", action: "demo.echo", parameters: { value: "tail" } },
] };
const yaml = stringify(blueprint);
async function setup(output: unknown = { parameters: { value: "proposed" } }) {
  const config = loadConfig({ APP_ENV: "test", JWT_SECRET: "commands-test-secret-at-least-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "mock" });
  const repository = new Repository(null), now = new Date().toISOString();
  await repository.mutate((state) => {
    for (const [id, roleId] of [["admin", "role_admin"], ["client", "role_client"]]) state.users[id!] = { id: id!, name: id!, email: `${id}@example.test`, roleId: roleId!, permissionOverrides: [], status: "Active", initials: "A", departmentId: null, createdAt: now, lastLoginAt: null };
    state.workflows.report = { id: "report", name: "Report", description: "Read report", owner: { id: "admin", name: "Admin" }, assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 3, successRate: 0, lastRunAt: null,
      publishedVersion: 1, draftVersion: 1, tags: [], domainTags: [], canRun: true, createdAt: now, updatedAt: now, yaml, archived: false } satisfies Workflow;
    state.versions.report = [{ version: 1, artifactState: "PUBLISHED", yaml }];
    state.chats.chat = { id: "chat", ownerId: "admin", title: "Node changes", createdAt: now, updatedAt: now, messageCount: 0, messages: [] };
  });
  const registries = await RegistryService.load(resolve("tests/fixtures/chat-read-tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
  const fetchImplementation = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] }));
  const providerRuntime = new ProviderRuntime(repository, executor, fetchImplementation);
  providerRuntime.activate({ id: "fixture", name: "Fixture", type: "openai_compatible", baseURL: "https://provider.example.test/v1", apiKey: "fixture", model: "fixture-v1", temperature: 0, timeoutMs: 1000 });
  const app = await buildApp({ config, repository, registries, validator, executor, providerRuntime }); apps.push(app);
  const headers = (id = "admin") => ({ authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { algorithm: "HS256", subject: id, expiresIn: 3600 })}` });
  const edit = (command: unknown, baseVersion = 1, baseHash = workflowContentHash(yaml), actor = "admin") => app.inject({ method: "POST", url: "/api/workflows/report/commands", headers: headers(actor), payload: { baseVersion, baseHash, command } });
  const propose = (extra: Record<string, unknown> = {}) => app.inject({ method: "POST", url: "/api/workflows/report/node-proposals", headers: headers(), payload: { baseVersion: 1, baseHash: workflowContentHash(yaml), nodeId: "first", prompt: "Change the value only", sessionId: "chat", ...extra } });
  return { app, repository, headers, edit, propose, fetchImplementation };
}

test("scoped node edit preserves unrelated nodes and control flow and creates a nonrunnable draft", async () => {
  const s = await setup(); const response = await s.edit({ type: "updateNode", nodeId: "first", patch: { parameters: { value: "edited" } } });
  expect(response.statusCode, response.body).toBe(200);
  const record = response.json().data;
  expect(record).toMatchObject({ version: 2, publishedVersion: 1, canRun: false, validation: { passed: true } });
  const next = parseWorkflowYAMLStrict(record.yaml);
  expect(next.steps[0]).toEqual({ ...blueprint.steps[0], parameters: { value: "edited" } });
  expect(next.steps.slice(1)).toEqual(blueprint.steps.slice(1));
  const state = await s.repository.snapshot();
  expect(state.versions.report?.[0]?.yaml).toBe(yaml);
  expect(state.versions.report?.at(-1)?.artifactState).toBe("DRAFT");
  expect(state.workflows.report?.pendingGenerationApproval?.steps[0]?.stepId).toBe("approval");
  expect(state.executions).toEqual({}); expect(s.fetchImplementation).not.toHaveBeenCalled();
});

async function conditionSetup(output: unknown = { predicate: { kind: "literal", value: false } }) {
  const s = await setup(output);
  const source = stringify({ name: "Conditional report", trigger: { type: "manual" }, steps: ["first", "last"].map(id => ({ id, action: "demo.echo", parameters: { value: id } })),
    metadata: { controlFlow: { schemaVersion: "read-control-flow/v1", root: { kind: "sequence", nodes: [{ kind: "if", id: "gate", predicate: { kind: "literal", value: true }, then: { kind: "sequence", nodes: [{ kind: "action", nodeId: "first" }] }, else: { kind: "sequence", nodes: [{ kind: "action", nodeId: "last" }] } }] } } } });
  await s.repository.mutate(state => { state.workflows.report!.yaml = source; state.versions.report![0]!.yaml = source; });
  return { ...s, source, hash: workflowContentHash(source) };
}

async function collectionSetup(output: unknown = { maxItems: 2 }) {
  const s = await setup(output);
  const source = stringify({ name: "Collection report", description: "Read a bounded supplied list", trigger: { type: "manual", config: { inputSchema: { type: "object", properties: { rows: { type: "array", items: { type: "string" } } }, required: ["rows"], additionalProperties: false } } },
    steps: ["first", "last"].map(id => ({ id, action: "demo.echo", parameters: { value: "{{each.item}}" } })), metadata: { controlFlow: { schemaVersion: "read-control-flow/v3", root: { kind: "sequence", nodes: [{ kind: "foreach", id: "each", maxItems: 3,
      items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "workflowInput", path: ["rows"] } }, body: { kind: "sequence", nodes: ["first", "last"].map(nodeId => ({ kind: "action", nodeId })) },
      collect: { schema: { type: "string" }, value: { kind: "ref", source: "nodeOutput", nodeId: "each", path: ["item"] } } }] } } } });
  await s.repository.mutate(state => { state.workflows.report!.yaml = source; state.versions.report![0]!.yaml = source; });
  return { ...s, source, hash: workflowContentHash(source) };
}

test("collection-owner proposal has a dedicated data-only scope and explicit partial apply preserves ID/body/publication", async () => {
  const s = await collectionSetup(), reply = await s.propose({ nodeId: "each", baseHash: s.hash });
  expect(reply.statusCode, reply.body).toBe(200); const proposal = reply.json().data;
  expect(proposal.command).toEqual({ type: "updateCollection", nodeId: "each", patch: { maxItems: 2 } });
  expect(proposal.validation.passed).toBe(true);
  expect((await s.repository.snapshot()).workflows.report!.yaml).toBe(s.source);
  const body = JSON.parse(String(s.fetchImplementation.mock.calls[0]![1]?.body)), data = JSON.parse(body.messages[1].content);
  expect(body.messages[0].content).toContain("ONE SELECTED COLLECTION PATCH"); expect(data.tools).toEqual([]);
  expect(data.allowedItemSources.map((value: any) => value.expression)).toEqual(["{{input}}", "{{input.rows}}"]);
  expect(data.allowedCollectSources.map((value: any) => value.expression)).toEqual(expect.arrayContaining(["{{each.item}}", "{{each.index}}"]));
  const applied = await s.app.inject({ method: "POST", url: "/api/workflows/report/commands", headers: s.headers(), payload: { baseVersion: 1, baseHash: s.hash, proposalId: proposal.id, command: proposal.command } });
  expect(applied.statusCode, applied.body).toBe(200);
  const original = parseWorkflowYAMLStrict(s.source) as any, next = parseWorkflowYAMLStrict(applied.json().data.yaml) as any;
  expect(next.steps).toEqual(original.steps); expect(next.metadata.controlFlow.root.nodes[0]).toEqual({ ...original.metadata.controlFlow.root.nodes[0], maxItems: 2 });
  const state = await s.repository.snapshot(); expect(state.versions.report![0]!.yaml).toBe(s.source); expect(state.workflows.report).toMatchObject({ draftVersion: 2, publishedVersion: 1, canRun: false });
  expect(state.executions).toEqual({}); expect(s.fetchImplementation).toHaveBeenCalledOnce();
});

test.each([{}, { body: { kind: "sequence", nodes: [] }, maxItems: 2 }, { id: "other", maxItems: 2 }, { kind: "action", maxItems: 2 },
  { action: "demo.echo" }, { parameters: { role: "admin" } }, { approved: true, maxItems: 2 }, { maxItems: 0 }, { maxItems: 101 }, { maxItems: 1.5 },
  { items: { schema: { type: "string" }, value: { kind: "literal", value: "not-a-list" } } }])("collection-owner model patch cannot enlarge scope or remove bounds: %j", async output => {
  const s = await collectionSetup(output), before = await s.repository.snapshot(), reply = await s.propose({ nodeId: "each", baseHash: s.hash });
  expect(reply.statusCode, reply.body).toBe(422); expect(reply.json().meta.code).toBe("NODE_PROPOSAL_INVALID");
  const state = await s.repository.snapshot(); expect(state.workflows).toEqual(before.workflows); expect(state.versions).toEqual(before.versions); expect(state.chats.chat!.messages).toEqual([]); expect(state.executions).toEqual({});
});

test.each([
  { items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "nodeOutput", nodeId: "each", path: ["value"] } } },
  { collect: { schema: { type: "string" }, value: { kind: "ref", source: "nodeOutput", nodeId: "future", path: ["value"] } } },
  { items: { schema: { type: "array", items: { type: "boolean" } }, value: { kind: "array", items: [{ kind: "literal", value: true }] } } },
])("invalid collection bindings %j remain explicitly blocked in proposal, apply and refreshed readiness", async output => {
  const s = await collectionSetup(output), reply = await s.propose({ nodeId: "each", baseHash: s.hash });
  expect(reply.statusCode, reply.body).toBe(200); const proposal = reply.json().data;
  expect(proposal.validation).toMatchObject({ passed: false, schema_ok: false, failed_rules: expect.arrayContaining(["WORKSPACE_READ_COMPILATION"]) });
  expect(proposal.validation.errors.some((issue: string) => issue.startsWith("WORKSPACE_READ_COMPILATION:"))).toBe(true);
  expect((await s.repository.snapshot()).workflows.report!.yaml).toBe(s.source);
  const applied = await s.app.inject({ method: "POST", url: "/api/workflows/report/commands", headers: s.headers(), payload: { baseVersion: 1, baseHash: s.hash, proposalId: proposal.id, command: proposal.command } });
  expect(applied.statusCode, applied.body).toBe(200); expect(applied.json().data).toMatchObject({ canRun: false, validation: { passed: false } });
  const ready = await s.app.inject({ method: "GET", url: "/api/workflows/report/readiness", headers: s.headers() });
  expect(ready.json().data).toMatchObject({ can_attempt_run: false, validation: { passed: false } });
  const state = await s.repository.snapshot(); expect(state.workflows.report!.status).toBe("draft-unvalidated"); expect(state.executions).toEqual({});
});

test("return proposals receive no tool definitions, preserve other nodes and apply only exact owned output edits", async () => {
  const output = { schema: { type: "boolean" }, value: { kind: "literal", value: false } }, s = await conditionSetup({ output });
  const value = parseWorkflowYAMLStrict(s.source) as any; value.metadata.controlFlow.schemaVersion = "read-control-flow/v2";
  value.metadata.controlFlow.root.nodes.push({ kind: "return", id: "answer", output: { schema: { type: "boolean" }, value: { kind: "literal", value: true } } });
  const source = stringify(value), hash = workflowContentHash(source);
  await s.repository.mutate(state => { state.workflows.report!.yaml = source; });
  const response = await s.propose({ nodeId: "answer", baseHash: hash }); expect(response.statusCode, response.body).toBe(200);
  const proposal = response.json().data; expect(proposal.command).toEqual({ type: "updateReturn", nodeId: "answer", patch: { output } });
  const body = JSON.parse(String(s.fetchImplementation.mock.calls[0]![1]?.body)); expect(body.messages[0].content).toContain("ONE SELECTED RETURN PATCH"); expect(JSON.parse(body.messages[1].content).tools).toEqual([]);
  expect((await s.repository.snapshot()).workflows.report!.yaml).toBe(source);
  const applied = await s.app.inject({ method: "POST", url: "/api/workflows/report/commands", headers: s.headers(), payload: { baseVersion: 1, baseHash: hash, command: proposal.command, proposalId: proposal.id } });
  expect(applied.statusCode, applied.body).toBe(200); expect(parseWorkflowYAMLStrict(applied.json().data.yaml).steps).toEqual(value.steps); expect((await s.repository.snapshot()).executions).toEqual({});
});
test("manual conditional HTTP commands create a revision-bound draft and preserve the immutable publication", async () => {
  const s = await conditionSetup();
  const response = await s.edit({ type: "updateCondition", nodeId: "gate", patch: { predicate: { kind: "literal", value: false } } }, 1, s.hash);
  expect(response.statusCode, response.body).toBe(200); expect(response.json().data).toMatchObject({ version: 2, canRun: false, publishedVersion: 1 });
  const state = await s.repository.snapshot(); expect(state.versions.report![0]!.yaml).toBe(s.source);
  expect(parseWorkflowYAMLStrict(response.json().data.yaml).steps).toEqual(parseWorkflowYAMLStrict(s.source).steps);
  expect((await s.edit({ type: "updateCondition", nodeId: "gate", patch: { predicate: { kind: "literal", value: true } } }, 1, s.hash)).statusCode).toBe(409);
  expect((await s.edit({ type: "removeCondition", nodeId: "gate" }, 1, s.hash, "client")).statusCode).toBe(403);
  expect(s.fetchImplementation).not.toHaveBeenCalled(); expect(state.executions).toEqual({});
});
test("selected condition model proposals change only the predicate and acceptance matches the saved exact command", async () => {
  const s = await conditionSetup(), response = await s.propose({ nodeId: "gate", baseHash: s.hash });
  expect(response.statusCode, response.body).toBe(200);
  const proposal = response.json().data; expect(proposal.command).toEqual({ type: "updateCondition", nodeId: "gate", patch: { predicate: { kind: "literal", value: false } } });
  expect((await s.repository.snapshot()).workflows.report!.yaml).toBe(s.source);
  const body = JSON.parse(String(s.fetchImplementation.mock.calls[0]![1]?.body));
  expect(body.messages[0].content).toContain("ONE SELECTED CONDITION PATCH"); expect(body.messages[0].content).toContain("Branch contents and scope are immutable");
  expect(JSON.parse(body.messages[1].content).tools).toEqual([]);
  const applied = await s.app.inject({ method: "POST", url: "/api/workflows/report/commands", headers: s.headers(), payload: { baseVersion: 1, baseHash: s.hash, command: proposal.command, proposalId: proposal.id } });
  expect(applied.statusCode, applied.body).toBe(200);
  expect(parseWorkflowYAMLStrict(applied.json().data.yaml).steps).toEqual(parseWorkflowYAMLStrict(s.source).steps);
  expect((await s.repository.snapshot()).executions).toEqual({});
});
test.each([{ predicate: { kind: "literal", value: false }, then: { kind: "sequence", nodes: [] } }, { action: "demo.echo" }, { predicate: { kind: "literal", value: "false" } }, { predicate: { kind: "ref", source: "workflowInput", path: ["__proto__"] } }])("condition proposal %j cannot escape its narrow patch contract", async output => {
  const s = await conditionSetup(output); expect((await s.propose({ nodeId: "gate", baseHash: s.hash })).statusCode).toBe(422);
  expect((await s.repository.snapshot()).workflows.report!.yaml).toBe(s.source); expect((await s.repository.snapshot()).chats.chat!.messages).toHaveLength(0);
});

test("same-base concurrent edits yield exactly one saved revision and one conflict", async () => {
  const s = await setup();
  const responses = await Promise.all(["a", "b"].map((description) => s.edit({ type: "updateNode", nodeId: "first", patch: { description } })));
  expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
  expect((await s.repository.snapshot()).workflows.report?.draftVersion).toBe(2);
});

test("add, move, remove and undo restore source without rewinding revision history", async () => {
  const s = await setup();
  let revision = { version: 1, contentHash: workflowContentHash(yaml), yaml };
  for (const change of [
    { type: "addNode", node: { id: "newNode", action: "demo.echo", parameters: { value: "new" } }, beforeNodeId: "last" },
    { type: "moveNode", nodeId: "newNode", beforeNodeId: "first" },
    { type: "removeNode", nodeId: "newNode" },
    { type: "restoreDraft", yaml },
  ]) {
    const response = await s.edit(change, revision.version, revision.contentHash);
    expect(response.statusCode, response.body).toBe(200); revision = response.json().data;
  }
  expect(revision.version).toBe(5);
  expect(parseWorkflowYAMLStrict(revision.yaml)).toEqual(blueprint);
});

test.each([
  { type: "updateNode", nodeId: "missing", patch: { description: "x" } },
  { type: "updateNode", nodeId: "first", patch: { id: "last" } },
  { type: "updateNode", nodeId: "first", patch: {} },
  { type: "moveNode", nodeId: "first", beforeNodeId: "first" },
  { type: "addNode", node: { id: "first", action: "demo.echo" }, beforeNodeId: null },
])("invalid scoped command %j leaves source unchanged", async (command) => {
  const s = await setup(); expect((await s.edit(command)).statusCode).toBeGreaterThanOrEqual(400);
  expect((await s.repository.snapshot()).workflows.report?.yaml).toBe(yaml);
});

test("unknown action is retained in a blocked draft, never renamed or auto-published", async () => {
  const s = await setup(); const response = await s.edit({ type: "updateNode", nodeId: "first", patch: { action: "missing-tool" } });
  expect(response.statusCode).toBe(200); expect(response.json().data.validation.passed).toBe(false);
  expect(response.json().data.yaml).toContain("missing-tool"); expect(response.json().data.canRun).toBe(false);
});

test("client cannot edit, and unassigned read readiness is hidden", async () => {
  const s = await setup(); expect((await s.edit({ type: "removeNode", nodeId: "last" }, 1, workflowContentHash(yaml), "client")).statusCode).toBe(403);
  expect((await s.app.inject({ method: "GET", url: "/api/workflows/report/readiness", headers: s.headers("client") })).statusCode).toBe(404);
});

test("node prompt returns a scope-bound preview and persists it in chat without changing workflow", async () => {
  const s = await setup(); const response = await s.propose(); expect(response.statusCode, response.body).toBe(200);
  const proposal = response.json().data;
  expect(proposal).toMatchObject({ nodeId: "first", baseVersion: 1, baseHash: workflowContentHash(yaml), status: "PROPOSED", command: { type: "updateNode", nodeId: "first" } });
  const state = await s.repository.snapshot();
  expect(state.workflows.report?.yaml).toBe(yaml); expect(state.chats.chat?.messages).toHaveLength(2);
  expect(s.fetchImplementation).toHaveBeenCalledTimes(1);
  const applied = await s.edit(proposal.command, proposal.baseVersion, proposal.baseHash);
  expect(applied.statusCode).toBe(200); expect(parseWorkflowYAMLStrict(applied.json().data.yaml).steps.slice(1)).toEqual(blueprint.steps.slice(1));
});

test.each([{ id: "last", parameters: { value: "bad" } }, { yaml: "replace whole workflow" }, {}, { action: "demo.echo", extra: true }])("unsupported model patch %j cannot escape node scope", async (output) => {
  const s = await setup(output); expect((await s.propose()).statusCode).toBe(422);
  expect((await s.repository.snapshot()).workflows.report?.yaml).toBe(yaml);
});

test("role revocation while model is running prevents proposal persistence", async () => {
  const s = await setup();
  s.fetchImplementation.mockImplementation(async () => { await s.repository.mutate((state) => { state.users.admin!.status = "Disabled"; }); return Response.json({ choices: [{ message: { content: '{"description":"changed"}' } }] }); });
  expect((await s.propose()).statusCode).toBe(403); expect((await s.repository.snapshot()).chats.chat?.messages).toHaveLength(0);
});

test("model wait does not block concurrent revisioned edits; stale proposal is rejected", async () => {
  const s = await setup(); let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; }), started = new Promise<void>((resolve) => { entered = resolve; });
  s.fetchImplementation.mockImplementation(async () => { entered(); await waiting; return Response.json({ choices: [{ message: { content: '{"description":"stale"}' } }] }); });
  const pending = s.propose(); await started;
  try { expect((await s.edit({ type: "updateNode", nodeId: "first", patch: { description: "current" } })).statusCode).toBe(200); }
  finally { release(); }
  expect((await pending).statusCode).toBe(409);
});

test("readiness separates validation, supported semantics, publication and disconnected bridge", async () => {
  const s = await setup(); const response = await s.app.inject({ method: "GET", url: "/api/workflows/report/readiness", headers: s.headers() });
  expect(response.statusCode).toBe(200);
  expect(response.json().data).toMatchObject({ published: true, bridge: "not_connected", can_attempt_run: false, validation: { passed: true } });
  expect(response.json().data.issues.length).toBeGreaterThan(0);
  expect(s.fetchImplementation).not.toHaveBeenCalled();
});

test("proposal acceptance is bound to the owned saved command and cannot be replayed", async () => {
  const s = await setup(); const proposal = (await s.propose()).json().data;
  const accept = (command = proposal.command, version = 1, hash = proposal.baseHash) => s.app.inject({ method: "POST", url: "/api/workflows/report/commands", headers: s.headers(), payload: { baseVersion: version, baseHash: hash, command, proposalId: proposal.id } });
  expect((await accept({ ...proposal.command, patch: { description: "not the proposed change" } })).statusCode).toBe(409);
  expect((await s.repository.snapshot()).workflows.report?.draftVersion).toBe(1);
  const result = await accept(); expect(result.statusCode, result.body).toBe(200);
  const state = await s.repository.snapshot();
  const artifact = state.chats.chat!.messages[1]!.artifacts as { proposal: Record<string, unknown> };
  expect(artifact.proposal).toMatchObject({ status: "APPLIED", appliedVersion: 2, resolvedBy: "admin" });
  expect((await accept(proposal.command, 2, result.json().data.contentHash)).statusCode).toBe(409);
  expect((await s.repository.snapshot()).workflows.report?.draftVersion).toBe(2);
});

test("discard persists without changing source or version and cannot be resolved twice", async () => {
  const s = await setup(); const proposal = (await s.propose()).json().data;
  const response = await s.edit({ type: "discardProposal", proposalId: proposal.id });
  expect(response.statusCode).toBe(200); expect(response.json().message).toContain("draft unchanged");
  const state = await s.repository.snapshot();
  expect(state.workflows.report).toMatchObject({ yaml, draftVersion: 1, publishedVersion: 1 });
  expect((state.chats.chat!.messages[1]!.artifacts as { proposal: Record<string, unknown> }).proposal).toMatchObject({ status: "DISCARDED", resolvedBy: "admin" });
  expect((await s.edit({ type: "discardProposal", proposalId: proposal.id })).statusCode).toBe(409);
});

test("saved proposals cannot be resolved through another admin's chat scope", async () => {
  const s = await setup(); const proposal = (await s.propose()).json().data;
  await s.repository.mutate((state) => { state.users.other = { ...state.users.admin!, id: "other", email: "other@example.test" }; });
  expect((await s.edit({ type: "discardProposal", proposalId: proposal.id }, 1, proposal.baseHash, "other")).statusCode).toBe(404);
});

test("proposal requests require an owned chat before calling the provider", async () => {
  const s = await setup();
  expect((await s.propose({ sessionId: undefined })).statusCode).toBe(400);
  expect((await s.propose({ sessionId: "not-owned" })).statusCode).toBe(404);
  expect(s.fetchImplementation).not.toHaveBeenCalled();
});

test("publication with a reviewed revision rejects stale or malformed review evidence", async () => {
  const s = await setup();
  const publish = (baseVersion: unknown, baseHash: unknown) => s.app.inject({ method: "POST", url: "/api/workflows/report/publish", headers: s.headers(), payload: { baseVersion, baseHash } });
  expect((await publish(1, "not-a-hash")).statusCode).toBe(400);
  expect((await publish(0, workflowContentHash(yaml))).statusCode).toBe(409);
  await s.edit({ type: "updateNode", nodeId: "first", patch: { description: "updated" } });
  expect((await publish(1, workflowContentHash(yaml))).statusCode).toBe(409);
  expect((await s.repository.snapshot()).workflows.report?.publishedVersion).toBe(1);
});

test("offline readiness returns local schema guidance without a provider call, mutation or runnable grant", async () => {
  const s = await setup(), before = await s.repository.snapshot();
  const response = await s.app.inject({ method: "GET", url: "/api/workflows/report/readiness", headers: s.headers() });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.authoring).toMatchObject({ profile: "read-authoring/v1", nodes: [{ nodeId: "first", state: "LOCAL_CONTRACT", inputSchema: { properties: { value: { type: "string" } } } }, { nodeId: "approval", state: "UNAVAILABLE" }, { nodeId: "last", dataSources: [] }] });
  expect(response.json().data.can_attempt_run).toBe(false);
  expect((await s.repository.snapshot()).workflows).toEqual(before.workflows); expect(s.fetchImplementation).not.toHaveBeenCalled();
});

test.each(["actor", "revision"])("readiness rechecks %s after awaited work before returning authoring context", async change => {
  const s = await setup();
  vi.spyOn(s.repository, "readAuthoritative").mockImplementationOnce(async callback => {
    await s.repository.mutate(state => { if (change === "actor") state.users.admin!.status = "Disabled"; else state.workflows.report!.draftVersion++; });
    return s.repository.read(callback);
  });
  const response = await s.app.inject({ method: "GET", url: "/api/workflows/report/readiness", headers: s.headers() });
  expect(response.statusCode, response.body).toBe(change === "actor" ? 403 : 409);
  expect(response.json().data).toBeNull(); expect(s.fetchImplementation).not.toHaveBeenCalled();
});

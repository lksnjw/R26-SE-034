import { afterEach, expect, test, vi } from "vitest";
import { publishProtectedOperation as publish, assertStoredProtectedOperationPublicationCurrent as current } from "../src/workflows/protected-operation-publication.js";
import { prepareProtectedOperationCompilation, protectedOperationPublicationCandidate } from "../src/workflows/protected-operation-preparation.js";
import { protectedPreparationFixture as fixture } from "./fixtures/protected-preparation.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import { Repository, type StoredRecord, type PersistenceBackend } from "../src/repository/store.js";
import { publicWorkflowVersion } from "../src/workflows/public-workflow-version.js";
import { splitFirestoreState, assembleFirestoreState } from "../src/storage/firestore-record-layout.js";
import { FirestoreRecordCodec } from "../src/storage/firestore-record-codec.js";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { admissionAuthorizer } from "../src/registry/capability-admission.js";

const closers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const value of closers.splice(0).reverse()) await value.close(); vi.restoreAllMocks(); });
async function setup(kind?: "analysis" | "agent" | "effect", readback = false, repository?: Repository) { const s = await fixture(kind, readback, repository); closers.push(s); return s; }
type Setup = Awaited<ReturnType<typeof setup>>;
const base = async (s: Setup) => s.repository.readAuthoritative(state => ({ baseVersion: state.workflows.flow!.draftVersion, baseHash: workflowContentHash(state.workflows.flow!.yaml) }));
const publishCurrent = async (s: Setup) => publish(s.services, "flow", s.actor, await base(s));
const validateCurrent = async (s: Setup, version: StoredRecord) => s.repository.readAuthoritative(state => current(state, s.services, String(version.id), "flow", s.actor.role));
const noCalls = (s: Setup) => { expect(s.sdk.callTool).not.toHaveBeenCalled(); expect(s.modelFetch).not.toHaveBeenCalled(); };

test.each([undefined, "analysis", "agent", "effect"] as const)("internal %s publication persists original v9 definitions without making them runnable", async kind => {
  const s = await setup(kind, kind === "effect"), version = await publishCurrent(s), saved = await s.repository.snapshot();
  expect(version).toMatchObject({ artifactState: "PUBLISHED", executionReadiness: "COMPILED_PROTECTED_RUNTIME_PENDING", version: 1,
    protectedCompilation: { profile: "protected-operation-publication/v1", runtimeQualified: false, verifiedRole: s.actor.role } });
  expect(version).not.toHaveProperty("protectedCompilationSecret"); expect(saved.workflows.flow).toMatchObject({ publishedVersion: 1, canRun: false });
  const secret = saved.versions.flow![0]!.protectedCompilationSecret as any;
  expect(secret.body.plan.ir.schemaVersion).toBe("workflow-operation-ir/v9"); expect(secret.body.plan.ir.root.nodes[1].kind).toBe(kind === "analysis" || kind === "agent" ? kind : "action");
  expect(secret.body.publisherContext.actorId).toBe(s.actor.id); expect(secret.seal).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(saved.versions.flow)).not.toMatch(/private-model-key|private-synthetic-token|configurationRevision|apiKey/);
  expect((await validateCurrent(s, version)).semanticHash).toBe((version.protectedCompilation as any).semanticHash);
  expect(saved.executions).toEqual({});
  expect(saved.auditLogs.filter(value => value.action === "workflow.protected_published_runtime_pending")).toHaveLength(1); noCalls(s);
});

test("normal versions API hides private IR/seal while publication and run remain refused", async () => {
  const s = await setup("analysis"), version = await publishCurrent(s);
  const response = await s.request("GET", "/api/workflows/flow/versions");
  expect(response.statusCode, response.body).toBe(200); expect(response.json().data).toEqual([version]);
  expect(response.body).not.toMatch(/protectedCompilationSecret|publisherContext|admissionBinding|providerBinding|private-model-key|private-synthetic-token|operation-ir|seal/);
  const normal = await s.request("POST", "/api/workflows/flow/publish", await base(s));
  expect(normal.statusCode, normal.body).toBe(422); expect(normal.body).toContain("PROTECTED_COLLECTION_RUNTIME_PENDING");
  const run = await s.request("POST", "/api/workflows/flow/run", { mode: "async-operation", input: { items: ["one"] }, idempotencyKey: "protected-internal-publication-no-run-01" });
  expect(run.statusCode, run.body).toBe(422); expect(run.body).toContain("PROTECTED_COLLECTION_RUNTIME_PENDING");
  expect((await s.repository.snapshot()).versions.flow).toHaveLength(1); noCalls(s);
});

test("same source and stable bindings reuse the immutable version, even after provider reactivation", async () => {
  const s = await setup("analysis"), first = await publishCurrent(s), before = (await s.repository.snapshot()).versions.flow;
  const oldRevision = s.providerRuntime.binding!.configurationRevision; s.providerRuntime.activate(s.providerRuntime.configuration!);
  expect(s.providerRuntime.binding!.configurationRevision).not.toBe(oldRevision);
  expect(await publishCurrent(s)).toEqual(first); expect((await s.repository.snapshot()).versions.flow).toEqual(before);
  const plan = await validateCurrent(s, first); plan.ir.root.nodes[0]!.id = "forged";
  expect((await validateCurrent(s, first)).ir.root.nodes[0]!.id).toBe("lookup"); noCalls(s);
});

test.each(["", "execute", "async-read"])("internal publication cannot enter the legacy %s run route", async mode => {
  const s = await setup(); await publishCurrent(s);
  const response = await s.request("POST", "/api/workflows/flow/run", { mode, input: { items: ["one"] },
    ...(mode === "async-read" ? { idempotencyKey: "protected-publication-no-legacy-read-001" } : {}) });
  expect(response.statusCode, response.body).toBe(422);
  expect(response.json().meta.code).toBe("UNSUPPORTED_EXECUTION_PROFILE");
  expect((await s.repository.snapshot()).executions).toEqual({}); noCalls(s);
});

test("changed model configuration rebinds as a new version without overwriting old publication", async () => {
  const s = await setup("analysis"), first = await publishCurrent(s), original = (await s.repository.snapshot()).versions.flow![0];
  const config = s.providerRuntime.configuration!; config.apiKey = "different-private-model-key"; s.providerRuntime.activate(config);
  await expect(validateCurrent(s, first)).rejects.toThrow(/publication/);
  const second = await publishCurrent(s), saved = await s.repository.snapshot();
  expect(second.version).toBe(2); expect(second.id).not.toBe(first.id); expect(saved.versions.flow![0]).toEqual(original);
  expect((second.protectedCompilation as any).bindingHash).not.toBe((first.protectedCompilation as any).bindingHash);
  expect(await publishCurrent(s)).toEqual(second); expect(saved.workflows.flow!.canRun).toBe(false); noCalls(s);
});

test.each(["temperature", "timeout", "model", "catalog", "egress", "provider ID", "origin"])("current publication refuses changed provider %s", async change => {
  const s = await setup("analysis"), version = await publishCurrent(s), config = s.providerRuntime.configuration!;
  if (change === "temperature") config.temperature = 0.2;
  if (change === "timeout") config.timeoutMs++;
  if (change === "model") config.model = "other-model";
  if (change === "catalog") config.additionalModels = [];
  if (change === "egress") config.egressPolicy!.runtimeAnalysisDataClasses = [];
  if (change === "provider ID") config.id = "other-provider";
  if (change === "origin") { config.baseURL = "https://changed.example.test/v1"; config.egressPolicy!.approvedOrigin = "https://changed.example.test"; }
  s.providerRuntime.activate(config); await expect(validateCurrent(s, version)).rejects.toThrow(); noCalls(s);
});

test("identical provider reconstructed after restart preserves the durable binding", async () => {
  const s = await setup("agent"), version = await publishCurrent(s), config = s.providerRuntime.configuration!;
  const restarted = new ProviderRuntime(s.repository, s.services.executor, s.modelFetch as typeof fetch); restarted.activate(config); s.services.providerRuntime = restarted;
  expect((await validateCurrent(s, version)).ir.root.nodes[1]!.kind).toBe("agent"); noCalls(s);
});

test("reconstructed reviewed SDK session retains publication without retaining socket or discovery generation", async () => {
  const s = await setup(), version = await publishCurrent(s); s.toolsChanged();
  const session = await createErpbridgeMcpSession({ baseURL: "https://synthetic.example.test", token: "private-synthetic-token", timeoutMs: 1000,
    validator: s.services.validator, sdkClient: s.sdk, admissionAuthorizer: admissionAuthorizer(s.repository, s.registries) });
  closers.push(session); s.services.erpbridgeSession = session;
  expect(session.admissionBinding).toBe(s.session.admissionBinding);
  expect((await validateCurrent(s, version)).ir.root.nodes[0]!.id).toBe("lookup");
  expect(await publishCurrent(s)).toEqual(version); noCalls(s);
});

test.each(["registry", "role map", "review", "governance", "approval role", "approval policy", "readback review"])("current publication refuses changed %s", async change => {
  const s = await setup("effect", true), version = await publishCurrent(s);
  if (change === "registry") vi.spyOn(s.registries, "hash").mockReturnValue(`sha256:${"a".repeat(64)}`);
  if (change === "role map") s.config.erpbridgeRoleMap["Platform Admin"] = "changed";
  await s.repository.mutate(state => {
    if (change === "review") state.capabilityAdmissions = {};
    if (change === "governance") state.governancePolicy = { revision: 999 };
    if (change === "approval role") state.roles.review!.permissions = [];
    if (change === "approval policy") (state.settings.rbac as any).runtimeApprovalPolicy.enabled = false;
    if (change === "readback review") {
      const stored = state.versions.flow![0]!.protectedCompilationSecret as any;
      const node = stored.body.plan.ir.root.nodes.find((value: any) => value.id === "send");
      state.capabilityAdmissions[node.readback.admission.capabilityId]!.state = "DISABLED";
    }
  });
  await expect(validateCurrent(s, version)).rejects.toThrow(); noCalls(s);
});

test("publication proof does not borrow historical publisher authority for future execution", async () => {
  const s = await setup(), version = await publishCurrent(s);
  await s.repository.mutate(state => { state.users.requester!.status = "Suspended"; state.workflows.flow!.assignedUserIds = ["other-user"]; });
  // This API validates only immutable publication/configuration, not admission.
  expect((await validateCurrent(s, version)).ir.verifiedRole).toBe(s.actor.role);
  await expect(publishCurrent(s)).rejects.toThrow(/authority/);
  expect((await s.repository.snapshot()).executions).toEqual({}); noCalls(s);
});

test.each(["seal", "receipt", "plan", "extra field", "missing field", "version ID", "version number", "workflow ID", "source", "created by", "created at", "runtime status", "legacy compilation", "duplicate ID"])("stored %s tampering fails closed", async damage => {
  const s = await setup(), version = await publishCurrent(s), snapshot = await s.repository.snapshot(), stored = snapshot.versions.flow![0]!, secret = stored.protectedCompilationSecret as any;
  if (damage === "seal") secret.seal = "0".repeat(64);
  if (damage === "receipt") (stored.protectedCompilation as any).runtimeQualified = true;
  if (damage === "plan") secret.body.plan.ir.root.nodes[0].id = "forged";
  if (damage === "extra field") secret.body.unknown = true;
  if (damage === "missing field") delete secret.body.publisherContext;
  if (damage === "version ID") stored.id = "other-version";
  if (damage === "version number") stored.version = 99;
  if (damage === "workflow ID") stored.workflowId = "other-flow";
  if (damage === "source") stored.yaml += "\n# tampered";
  if (damage === "created by") stored.createdBy = { id: "other", name: "other" };
  if (damage === "created at") stored.createdAt = new Date(0).toISOString();
  if (damage === "runtime status") stored.executionReadiness = "COMPILED_OPERATION";
  if (damage === "legacy compilation") stored.compiledOperation = { receipt: {} };
  if (damage === "duplicate ID") snapshot.versions.flow!.push(structuredClone(stored));
  expect(() => current(snapshot, s.services, String(version.id), "flow", s.actor.role)).toThrow(); noCalls(s);
});

test.each(["key", "application", "driver", "project", "database", "workspace"])("copied publication cannot cross the configured %s boundary", async change => {
  const s = await setup(); s.config.storageDriver = "firestore-records"; s.config.firestoreProjectId = "demo-lcwe-records";
  s.config.firestoreDatabaseId = "(default)"; s.config.firestoreWorkspaceId = "publication-test";
  const version = await publishCurrent(s);
  if (change === "key") s.config.storageEncryptionKey = "y".repeat(32);
  if (change === "application") s.config.appName += "-other";
  if (change === "driver") s.config.storageDriver = "memory";
  if (change === "project") s.config.firestoreProjectId = "demo-other";
  if (change === "database") s.config.firestoreDatabaseId = "other-db";
  if (change === "workspace") s.config.firestoreWorkspaceId = "other-workspace";
  await expect(validateCurrent(s, version)).rejects.toThrow(); noCalls(s);
});

test.each(["source", "revision", "actor", "permissions", "department", "governance", "provider", "signing key", "namespace"])("validation-time %s drift commits no publication", async change => {
  const s = await setup("analysis"), validate = s.services.validator.validateAndIssueToken.bind(s.services.validator);
  vi.spyOn(s.services.validator, "validateAndIssueToken").mockImplementation(async (...args) => {
    const gate = await validate(...args);
    await s.repository.mutate(state => {
      if (change === "source") state.workflows.flow!.yaml += "\n# changed";
      if (change === "revision") state.workflows.flow!.draftVersion++;
      if (change === "actor") state.users.requester!.status = "Suspended";
      if (change === "permissions") state.users.requester!.permissionOverrides = ["unreviewed:new"];
      if (change === "department") state.users.requester!.departmentId = "other-department";
      if (change === "governance") state.governancePolicy = { revision: 2 };
    });
    if (change === "provider") s.providerRuntime.activate(s.providerRuntime.configuration!);
    if (change === "signing key") s.config.storageEncryptionKey = "y".repeat(32);
    if (change === "namespace") s.config.appName = "other-application";
    return gate;
  });
  await expect(publishCurrent(s)).rejects.toThrow(); expect((await s.repository.snapshot()).versions.flow).toEqual([]); noCalls(s);
});

test.each(["failed", "missing token", "foreign source token"])("%s validation cannot publish", async change => {
  const s = await setup(), validate = s.services.validator.validateAndIssueToken.bind(s.services.validator);
  vi.spyOn(s.services.validator, "validateAndIssueToken").mockImplementation(async (...args) => {
    const value = await validate(...args);
    if (change === "failed") value.result.passed = false;
    if (change === "missing token") value.token = null;
    if (change === "foreign source token") value.token = (await validate(args[0], `${args[1]}\n# foreign exact bytes`, args[2])).token;
    return value;
  });
  await expect(publishCurrent(s)).rejects.toThrow(/validation failed/); expect((await s.repository.snapshot()).versions.flow).toEqual([]); noCalls(s);
});

test("wrong-role or missing version cannot be revalidated, and invalid revision cannot publish", async () => {
  const s = await setup(), version = await publishCurrent(s), snapshot = await s.repository.snapshot();
  expect(() => current(snapshot, s.services, String(version.id), "flow", "Foreign role")).toThrow();
  expect(() => current(snapshot, s.services, "missing", "flow", s.actor.role)).toThrow();
  await expect(publish(s.services, "flow", s.actor, { ...await base(s), baseVersion: 99 })).rejects.toThrow();
  expect((await s.repository.snapshot()).versions.flow).toHaveLength(1); noCalls(s);
});

test("a forged validation success/token cannot authorize publication", async () => {
  const s = await setup(), validate = s.services.validator.validateAndIssueToken.bind(s.services.validator);
  vi.spyOn(s.services.validator, "validateAndIssueToken").mockImplementation(async (...args) => { const value = await validate(...args); return { ...value, token: structuredClone(value.token) }; });
  await expect(publishCurrent(s)).rejects.toThrow(/validation failed/); expect((await s.repository.snapshot()).versions.flow).toEqual([]); noCalls(s);
});

test("inspection mints and serialized copies cannot extract publication material", async () => {
  const s = await setup(), inspection = await prepareProtectedOperationCompilation(s.services, "flow", s.actor), snapshot = await s.repository.snapshot();
  expect(() => protectedOperationPublicationCandidate(inspection, s.services, snapshot, s.actor)).toThrow(/not owned/);
  const prepared = await prepareProtectedOperationCompilation(s.services, "flow", s.actor, "publication");
  expect(() => protectedOperationPublicationCandidate(structuredClone(prepared), s.services, snapshot, s.actor)).toThrow(/not owned/); noCalls(s);
});

test("normalized encrypted Firestore version records retain private publication across reopen", async () => {
  const s = await setup("analysis"), version = await publishCurrent(s), before = await s.repository.snapshot();
  const codec = new FirestoreRecordCodec(s.config.storageEncryptionKey, { projectId: "demo-lcwe-records", databaseId: "(default)", workspaceId: "publication-test" });
  const records = splitFirestoreState(before), encoded = records.map(record => codec.encodeRecord(record));
  const decoded = encoded.map(value => codec.decodeRecord(value.chunks.map(chunk => codec.decodeChunk(chunk.id, chunk.document))));
  const restored = assembleFirestoreState(decoded), repository = new Repository(null, restored); closers.push(repository);
  expect(restored.versions.flow).toEqual(before.versions.flow);
  expect(encoded.flatMap(value => value.chunks).every(chunk => !chunk.document.payload.includes(Buffer.from("protectedCompilationSecret")))).toBe(true);
  const services = { ...s.services, repository };
  const plan = await repository.readAuthoritative(state => current(state, services, String(version.id), "flow", s.actor.role));
  expect(plan.semanticHash).toBe((version.protectedCompilation as any).semanticHash); noCalls(s);
});

test.each(["before", "after"])("publication %s-COMMIT acknowledgement loss is unconfirmed and reconciles without duplicate", async phase => {
  let bytes: Uint8Array | null = null, lose = false;
  const persistence: PersistenceBackend = { readQueueDurability: "encrypted-single-writer", load: async () => bytes, probe: async () => {}, close: async () => {}, save: async payload => {
    const publicationCommit = lose && JSON.parse(Buffer.from(payload).toString()).versions.flow.some((value: StoredRecord) => value.protectedCompilationSecret);
    if (publicationCommit && phase === "before") throw new Error("Synthetic pre-COMMIT fault");
    bytes = Uint8Array.from(payload); if (publicationCommit) throw new Error("Synthetic lost COMMIT ACK");
  } };
  const repository = await Repository.open(persistence), s = await setup(undefined, false, repository), revision = await base(s); lose = true;
  await expect(publish(s.services, "flow", s.actor, revision)).rejects.toMatchObject({ status: 503, meta: { code: "PROTECTED_PUBLICATION_UNCONFIRMED" } });
  expect(() => repository.assertAuthority()).toThrow(); lose = false; await repository.recoverPersistenceState();
  expect((await repository.snapshot()).versions.flow).toHaveLength(phase === "after" ? 1 : 0);
  const reconciled = await publish(s.services, "flow", s.actor, revision);
  expect((await repository.snapshot()).versions.flow).toHaveLength(1); expect(reconciled.version).toBe(1); noCalls(s);
});

test("legacy version receipt projections remain unchanged and detached", () => {
  const old = { id: "v1", yaml: "source", compiledRead: { receipt: { oldRead: true }, plan: { private: true } }, compiledOperation: { receipt: { oldOperation: true }, plan: { private: true } }, protectedCompilationSecret: { seal: "private" } };
  const result = publicWorkflowVersion(old); expect(result).toEqual({ id: "v1", yaml: "source", compiledRead: { oldRead: true }, compiledOperation: { oldOperation: true } });
  (result.compiledRead as any).oldRead = false; expect(old.compiledRead.receipt.oldRead).toBe(true);
});

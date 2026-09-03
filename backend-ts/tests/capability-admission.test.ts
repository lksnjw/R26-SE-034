import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { afterEach, expect, test, vi } from "vitest";
import { RegistryService } from "../src/registry/service.js";
import { Repository, type PersistenceBackend } from "../src/repository/store.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { toolSchema } from "../src/registry/schemas.js";
import { admissionAuthorizer, observeCapabilities, reviewCapability, disableCapability, capabilityAdmissionCatalog, capabilityContractHash, requireProductionAdmissionProfile } from "../src/registry/capability-admission.js";
import { bridgeTransportSchema, exactBridgeName } from "../src/tools/erpbridge-contract.js";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
import { discoverTools } from "../src/agent/tool-discovery.js";
import { dispatchReadTool } from "../src/tools/read-tool-broker.js";
import { buildApp } from "../src/http/app.js";
import { loadConfig } from "../src/config/config.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";

const sessions: { close(): Promise<unknown> }[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(value => value.close())); });
class Persistence implements PersistenceBackend {
  readonly readQueueDurability = "encrypted-single-writer" as const;
  payload: Uint8Array | null = null; loseAck = false;
  async load() { return this.payload; }
  async save(bytes: Uint8Array) { this.payload = Buffer.from(bytes); if (this.loseAck) { this.loseAck = false; throw new Error("Commit acknowledgement lost"); } }
  async close() {} async probe() {}
}
async function setup(persistence: PersistenceBackend | null = null, noAuthorizer = false) {
  const repository = await Repository.open(persistence), timestamp = new Date().toISOString();
  await repository.mutate(state => { for (const [id, roleId] of [["admin", "role_admin"], ["builder", "role_builder"]]) state.users[id!] = { id: id!, name: id!, email: `${id}@example.test`, roleId: roleId!, status: "Active", permissionOverrides: [], initials: "A", departmentId: null, lastLoginAt: null, createdAt: timestamp }; });
  const registries = await RegistryService.load(resolve("tests/fixtures/chat-read-tools.json"), resolve("tests/fixtures/rules.json"));
  let tool = toolSchema.parse({ ...registries.snapshot().tools[0], bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [] } });
  const original = registries.snapshot();
  vi.spyOn(registries, "snapshot").mockImplementation(() => ({ ...original, tools: [tool] }));
  vi.spyOn(registries, "findTool").mockImplementation(name => [tool.name, tool.mcp_tool_name, tool.tool_id].includes(name) ? tool : undefined);
  vi.spyOn(registries, "hash").mockImplementation(() => capabilityContractHash(tool));
  const validator = new RegistryValidator(registries, repository);
  let generationListener: (() => void) | undefined;
  const remote = () => ({ name: exactBridgeName(tool), inputSchema: bridgeTransportSchema(tool), _meta: { "toolplane.resourceDigest": tool.bridge_contract!.resource_digest, "toolplane.resourceVersion": tool.bridge_contract!.resource_version, "io.erpbridge/allowedRoles": [] } });
  const sdk = { metadataComplete: true, connect: vi.fn(async () => {}), close: vi.fn(async () => {}), onToolsChanged: (listener: () => void) => { generationListener = listener; return () => {}; },
    listTools: vi.fn(async () => [remote()]), callTool: vi.fn(async () => ({ content: [{ type: "text", text: "Confirmed fixture" }] })) };
  const session = await createErpbridgeMcpSession({ baseURL: "https://fixture.example.test", token: "private-credential", timeoutMs: 1000, validator, sdkClient: sdk,
    ...(!noAuthorizer ? { admissionAuthorizer: admissionAuthorizer(repository, registries) } : {}) }); sessions.push(session);
  const admin = (await repository.effectiveUser("admin"))!, builder = (await repository.effectiveUser("builder"))!;
  const config = loadConfig({ APP_ENV: "test", JWT_SECRET: "admission-test-secret-at-least-32-bytes", STORAGE_DRIVER: "memory", MCP_MODE: "mock" });
  const services = { repository, registries, validator, erpbridgeSession: session, config, executor: new Executor(new ToolRegistry(), validator) };
  const observe = () => observeCapabilities({ repository, registries, session, user: admin });
  const body = (observation: { id: string; contractHash: string }, extra = {}) => ({ observationId: observation.id, contractHash: observation.contractHash,
    decisionKey: "review-fixture-key-0001", effectClass: "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Reviewed exact fixture and read policy", ...extra });
  const review = async (extra = {}) => { const observation = (await observe()).observations[0]!; return reviewCapability({ repository, registries, session, user: admin, capabilityId: observation.capabilityId, body: body(observation, extra) }); };
  return { repository, registries, validator, session, sdk, admin, builder, services, observe, body, review, remote,
    tool: () => tool, changeTool: (patch: Partial<typeof tool>) => { tool = { ...tool, ...patch }; }, changed: () => generationListener?.() };
}

test("modern discovery is not permission; explicit saved review enables one exact governed read and warm discovery never grants from cache", async () => {
  const s = await setup(); expect(await discoverTools(s.session, s.registries)).toEqual([]);
  const observation = (await s.observe()).observations[0]!;
  expect(observation.state).toBe("REVIEW_REQUIRED"); expect(Object.keys((await s.repository.snapshot()).capabilityAdmissions)).toHaveLength(0);
  await expect(dispatchReadTool(s.services, "admin", s.tool().name, { value: "fixture" })).rejects.toThrow(); expect(s.sdk.callTool).not.toHaveBeenCalled();
  const reviewed = await reviewCapability({ ...s.services, session: s.session, user: s.admin, capabilityId: observation.capabilityId, body: s.body(observation) });
  expect(reviewed.admission).toMatchObject({ state: "AVAILABLE", version: 1 }); expect(reviewed.revision.reviewedBy.id).toBe("admin");
  const calls = s.sdk.listTools.mock.calls.length; expect(await discoverTools(s.session, s.registries)).toEqual([s.tool()]); expect(s.sdk.listTools).toHaveBeenCalledTimes(calls);
  const result = await dispatchReadTool(s.services, "admin", s.tool().name, { value: "fixture" }); expect(result.content).toEqual([{ type: "text", text: "Confirmed fixture" }]);
  expect(s.sdk.callTool).toHaveBeenCalledOnce(); expect(s.sdk.callTool.mock.calls[0]).toEqual([exactBridgeName(s.tool()), { value: "fixture" }, { "toolplane.resourceDigest": "a".repeat(64) }]);
});

test("disable is authoritative immediately, review retries never re-enable, and duplicate decisions do not create new revisions", async () => {
  const s = await setup(), reviewed = await s.review(), observation = (await capabilityAdmissionCatalog(s.repository)).observations[0]!;
  const repeated = await reviewCapability({ ...s.services, session: s.session, user: s.admin, capabilityId: reviewed.admission.capabilityId, body: s.body(observation) });
  expect(repeated.duplicate).toBe(true); expect(repeated.revision.id).toBe(reviewed.revision.id);
  const disabled = await disableCapability({ repository: s.repository, user: s.admin, capabilityId: reviewed.admission.capabilityId, body: { revisionId: reviewed.revision.id, baseVersion: 1, note: "Revoke fixture" } });
  expect(disabled.state).toBe("DISABLED"); expect(await discoverTools(s.session, s.registries)).toEqual([]);
  await expect(s.session.assertAdmission!(s.tool())).rejects.toThrow(/disabled/);
  const retry = await reviewCapability({ ...s.services, session: s.session, user: s.admin, capabilityId: reviewed.admission.capabilityId, body: s.body(observation) });
  expect(retry.admission.state).toBe("DISABLED"); expect(Object.keys((await s.repository.snapshot()).capabilityRevisions)).toHaveLength(1); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("drift refresh blocks an existing admission, records audit, and restored discovery cannot automatically grant again", async () => {
  const s = await setup(); const reviewed = await s.review();
  s.sdk.listTools.mockImplementationOnce(async () => []);
  expect((await s.observe()).blockedCount).toBe(1);
  expect((await capabilityAdmissionCatalog(s.repository)).admissions[0]).toMatchObject({ state: "BLOCKED", reason: "REMOTE_CONTRACT_DRIFT", version: 2 });
  expect((await s.observe()).blockedCount).toBe(0);
  await expect(s.session.assertAdmission!(s.tool())).rejects.toThrow(/blocked/);
  const again = await s.review({ decisionKey: "review-fixture-key-0002" });
  expect(again.admission).toMatchObject({ state: "AVAILABLE", version: 3 }); expect(again.revision.id).not.toBe(reviewed.revision.id);
  expect((await s.repository.snapshot()).auditLogs.some(entry => entry.action === "capability.drift.blocked")).toBe(true);
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("review catalog is bounded and pageable, and unsafe review classes cannot enable production-only test or effect tools", async () => {
  const s = await setup();
  for (let index = 0; index < 12; index++) await s.observe();
  expect((await capabilityAdmissionCatalog(s.repository)).observations).toHaveLength(10);
  expect((await capabilityAdmissionCatalog(s.repository, 10)).observations).toHaveLength(2);
  await expect(capabilityAdmissionCatalog(s.repository, 0, 11)).rejects.toThrow(/catalog page/);
  for (const patch of [{ is_read_only: false }, { name: "system.write_test" }, { risk_level: "" }, { side_effects: ["Updates ERP"] }]) {
    const original = s.tool(); s.changeTool(patch);
    await expect(s.review()).rejects.toThrow(/unsupported effect/); s.changeTool(original);
  }
  expect(Object.keys((await s.repository.snapshot()).capabilityAdmissions)).toHaveLength(0); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test.each(["roles", "risk", "input", "digest", "description"])("local %s drift invalidates review and cannot dispatch", async field => {
  const s = await setup(); await s.review();
  if (field === "roles") s.changeTool({ allowed_roles: ["Workflow Builder"] });
  if (field === "risk") s.changeTool({ risk_level: "high" });
  if (field === "input") s.changeTool({ input_schema: { type: "object" } });
  if (field === "digest") s.changeTool({ bridge_contract: { ...s.tool().bridge_contract!, resource_digest: "b".repeat(64) } });
  if (field === "description") s.changeTool({ description: "Changed source contract" });
  await expect(s.session.assertAdmission!(s.tool())).rejects.toThrow(/binding changed/); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test.each(["missing", "remote-drift", "generation", "expired", "reviewer", "effect"])("admission rejects %s without a grant", async scenario => {
  const s = await setup();
  if (scenario === "remote-drift") s.sdk.listTools.mockImplementation(async () => [{ ...s.remote(), _meta: { ...s.remote()._meta, "toolplane.resourceDigest": "b".repeat(64) } }]);
  const observation = (await s.observe()).observations[0]!;
  if (scenario === "generation") s.changed();
  if (scenario === "expired") await s.repository.mutate(state => { state.capabilityObservations[observation.id]!.discoveredAt = "2000-01-01T00:00:00.000Z"; });
  const user = scenario === "reviewer" ? s.builder : s.admin;
  const body = scenario === "missing" ? {} : s.body(observation, scenario === "effect" ? { effectClass: "write" } : {});
  await expect(reviewCapability({ ...s.services, session: s.session, user, capabilityId: observation.capabilityId, body })).rejects.toThrow();
  expect(Object.keys((await s.repository.snapshot()).capabilityAdmissions)).toHaveLength(0); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("lost committed review/disable acknowledgement fences dispatch until authoritative recovery, then respects the actual state", async () => {
  const persistence = new Persistence(), s = await setup(persistence), observation = (await s.observe()).observations[0]!;
  persistence.loseAck = true;
  await expect(reviewCapability({ ...s.services, session: s.session, user: s.admin, capabilityId: observation.capabilityId, body: s.body(observation) })).rejects.toThrow(/acknowledgement/);
  await expect(s.session.assertAdmission!(s.tool())).rejects.toThrow(/Authoritative/); await s.repository.recoverPersistenceState();
  const reviewed = await reviewCapability({ ...s.services, session: s.session, user: s.admin, capabilityId: observation.capabilityId, body: s.body(observation) });
  expect(reviewed.duplicate).toBe(true); await s.session.assertAdmission!(s.tool());
  persistence.loseAck = true;
  await expect(disableCapability({ repository: s.repository, user: s.admin, capabilityId: observation.capabilityId, body: { revisionId: reviewed.revision.id, baseVersion: 1, note: "Disable" } })).rejects.toThrow();
  await expect(s.session.assertAdmission!(s.tool())).rejects.toThrow(/Authoritative/); await s.repository.recoverPersistenceState();
  await expect(s.session.assertAdmission!(s.tool())).rejects.toThrow(/disabled/); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("modern session without persisted-authorizer wiring and private policy calls cannot bypass admission", async () => {
  const s = await setup(null, true); await s.review();
  await expect(s.session.assertAdmission!(s.tool())).rejects.toThrow(/persisted capability admission/);
  s.changeTool({ mcp_tool_name: "check_policy" });
  await expect(s.session.callToolDirect("check_policy", { value: "fixture" })).rejects.toThrow(/persisted capability admission/); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("connection rotation, corrupt review and decision conflicts are fail-closed; catalog hides private binding/decision identities", async () => {
  const s = await setup(), reviewed = await s.review(), catalog = await capabilityAdmissionCatalog(s.repository), observation = catalog.observations[0]!;
  expect(JSON.stringify(catalog)).not.toMatch(/connectionBinding|decisionScope|decisionHash|private-credential/);
  await expect(admissionAuthorizer(s.repository, s.registries)(s.tool(), "b".repeat(64))).rejects.toThrow(/binding changed/);
  await expect(reviewCapability({ ...s.services, session: s.session, user: s.admin, capabilityId: observation.capabilityId, body: s.body(observation, { note: "Different decision" }) })).rejects.toThrow(/different review input/);
  await s.repository.mutate(state => { state.capabilityRevisions[reviewed.revision.id]!.definition = { ...s.tool(), allowed_roles: ["anyone"] }; });
  await expect(s.session.assertAdmission!(s.tool())).rejects.toThrow(/binding changed/); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("registry review HTTP routes enforce current administrator authority and do not expose private binding", async () => {
  const s = await setup(), app = await buildApp(s.services); sessions.push(app);
  const headers = (actor = "admin") => ({ authorization: `Bearer ${jwt.sign({}, s.services.config.jwtSecret, { subject: actor, expiresIn: 3600 })}` });
  expect((await app.inject({ method: "POST", url: "/api/registry/capabilities/discovery", headers: headers("builder"), payload: {} })).statusCode).toBe(403);
  const scan = await app.inject({ method: "POST", url: "/api/registry/capabilities/discovery", headers: headers(), payload: {} });
  expect(scan.statusCode, scan.body).toBe(200); expect(scan.body).not.toMatch(/connectionBinding|private-credential/);
  const observation = scan.json().data.observations[0];
  const admitted = await app.inject({ method: "POST", url: `/api/registry/capabilities/${observation.capabilityId}/review`, headers: headers(), payload: s.body(observation) });
  expect(admitted.statusCode, admitted.body).toBe(200); expect(admitted.json().data.admission.state).toBe("AVAILABLE");
  await s.repository.mutate(state => { state.users.admin!.status = "Inactive"; });
  expect((await app.inject({ method: "POST", url: `/api/registry/capabilities/${observation.capabilityId}/disable`, headers: headers(), payload: {} })).statusCode).toBe(403);
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("unreviewed legacy remote transport is not a production fallback; mocks and supported modern profile remain explicit", () => {
  expect(() => requireProductionAdmissionProfile({ mcpMode: "remote", mcpTransport: "bridge-v1" })).toThrow(/no reviewed/);
  expect(() => requireProductionAdmissionProfile({ mcpMode: "mock", mcpTransport: "bridge-v1" })).not.toThrow();
  expect(() => requireProductionAdmissionProfile({ mcpMode: "remote", mcpTransport: "erpbridge-mcp" })).not.toThrow();
});

test("persisted review survives restart while malformed collections require repair instead of being discarded", async () => {
  const persistence = new Persistence(), s = await setup(persistence); await s.review();
  const restored = await Repository.open(persistence); await admissionAuthorizer(restored, s.registries)(s.tool(), s.session.admissionBinding!);
  const corrupted = JSON.parse(Buffer.from(persistence.payload!).toString()); corrupted.capabilityAdmissions = [];
  persistence.payload = Buffer.from(JSON.stringify(corrupted)); await expect(Repository.open(persistence)).rejects.toThrow(/admission recovery requires repair/);
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("unqualified multi-writer storage cannot admit or execute using a process-local view", async () => {
  const persistence = new Persistence(); Object.defineProperty(persistence, "readQueueDurability", { value: undefined });
  const s = await setup(persistence); await expect(s.review()).rejects.toThrow(/single-writer storage/);
  await expect(s.session.assertAdmission!(s.tool())).rejects.toThrow(/single-writer storage/);
  expect((await capabilityAdmissionCatalog(s.repository)).persistence).toBe("unsupported-for-admission"); expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("joined review view pairs latest unique observation with the actual active revision independently of history paging", async () => {
  const s = await setup(), reviewed = await s.review();
  for (let index = 0; index < 12; index++) await s.observe();
  const view = await capabilityAdmissionCatalog(s.repository, 0, 10, { registries: s.registries, session: s.session });
  expect(view.observations).toHaveLength(10); expect(view.capabilities).toHaveLength(1); expect(view.hasMoreCapabilities).toBe(false);
  expect(view.capabilities[0]).toMatchObject({ effectiveState: "AVAILABLE", reviewEligible: true, admission: reviewed.admission, revision: { id: reviewed.revision.id } });
  expect(view.capabilities[0]!.observation!.id).not.toBe(reviewed.revision.observationId);
  expect(JSON.stringify(view)).not.toMatch(/connectionBinding|decisionScope|decisionHash|private-credential/);
  expect((await capabilityAdmissionCatalog(s.repository, 10, 10, { registries: s.registries, session: s.session })).capabilities).toEqual([]);
});

test("review eligibility and displayed current drift are honest snapshots; a GET never modifies stored authority", async () => {
  const s = await setup(), reviewed = await s.review();
  s.changeTool({ description: "Updated local contract" });
  const view = await capabilityAdmissionCatalog(s.repository, 0, 10, { registries: s.registries, session: s.session });
  expect(view.capabilities[0]).toMatchObject({ effectiveState: "BLOCKED", reviewEligible: false, reviewReason: "LOCAL_CONTRACT_CHANGED", admission: { state: "AVAILABLE" } });
  expect((await s.repository.snapshot()).capabilityAdmissions[reviewed.admission.capabilityId]!.state).toBe("AVAILABLE");
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});

test("closed/missing/unsupported sessions never appear live-qualified and cannot be reviewed from catalog hints", async () => {
  const s = await setup(); await s.review();
  const absent = await capabilityAdmissionCatalog(s.repository, 0, 10, { registries: s.registries });
  expect(absent.connection).toMatchObject({ state: "NO_SESSION", discoveryAvailable: false });
  expect(absent.capabilities[0]).toMatchObject({ effectiveState: "BLOCKED", reviewEligible: false, reviewReason: "CONNECTION_UNAVAILABLE" });
  const unsupported = await capabilityAdmissionCatalog(s.repository, 0, 10, { registries: s.registries, session: { ...s.session, requiresReviewedRevision: false } });
  expect(unsupported.connection.state).toBe("UNSUPPORTED_PROFILE");
  const initialized = await capabilityAdmissionCatalog(s.repository, 0, 10, { registries: s.registries, session: s.session });
  expect(initialized.connection.state).toBe("INITIALIZED_NOT_QUALIFIED");
  await s.session.close();
  expect((await capabilityAdmissionCatalog(s.repository, 0, 10, { registries: s.registries, session: s.session })).connection).toMatchObject({ state: "CLOSED", discoveryAvailable: false });
});

test("catalog rejects fresh review on stale generations or unsupported effect classes without hiding saved history", async () => {
  const s = await setup(); await s.review(); s.changed();
  expect((await capabilityAdmissionCatalog(s.repository, 0, 10, { registries: s.registries, session: s.session })).capabilities[0]).toMatchObject({ reviewEligible: false, reviewReason: "OBSERVATION_STALE" });
  s.changeTool({ is_read_only: false }); await s.observe();
  const view = await capabilityAdmissionCatalog(s.repository, 0, 10, { registries: s.registries, session: s.session });
  expect(view.capabilities[0]).toMatchObject({ effectiveState: "BLOCKED", reviewEligible: false, reviewReason: "UNSUPPORTED_EFFECT_OR_RISK", revision: { policy: { effectClass: "read" } } });
  expect(s.sdk.callTool).not.toHaveBeenCalled();
});

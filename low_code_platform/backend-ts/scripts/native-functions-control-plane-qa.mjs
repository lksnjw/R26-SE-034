// Actual Functions/Firestore recovery qualification in the existing isolated
// Docker fixture. The only model request is a fixed-public-literal loopback
// probe, not external inference or an ERP/business operation.
import assert from "node:assert/strict";
import { nativeModelIds, startNativeModelFixture } from "./native-functions-model-qa.mjs";

export async function qualifyNativeControlPlane({ request, open, config }) {
  assert.equal(config.LCWE_LOCAL_DOCKER_QA, "native-read/v1");
  const fixture = await startNativeModelFixture(config);
  const legacyIds = ["native_recovery_legacy_one", "native_recovery_legacy_two"];
  const roleId = "native_recovery_wrong_platform_role", userId = "native_recovery_nonadmin";
  const ownedIds = new Set(legacyIds);
  let seeded = false, accepted = false;
  const access = async work => {
    const repository = await open();
    try { return await work(repository); } finally { await repository.close(); }
  };
  const checked = async (path, method, payload, status = 200, authorization = true) => {
    const result = await request("api", path, method, payload, authorization);
    assert.equal(result.status, status, `Native control-plane status mismatch: ${method} ${path}`);
    assert(!result.body.includes(fixture.apiKey), "Recovery fixture credential escaped HTTP");
    return result.data;
  };
  try {
    await access(repository => repository.mutate(state => {
      assert.equal(Object.keys(state.providers).length, 0, "Recovery qualification requires a fresh synthetic provider namespace");
      assert(state.users.native_owner && !state.users[userId] && !state.roles[roleId]);
      for (const [index, id] of legacyIds.entries()) state.providers[id] = {
        id, name: `Legacy recovery fixture ${index + 1}`, type: "unsupported", active: true,
        baseUrl: fixture.baseUrl, apiKey: fixture.apiKey, model: nativeModelIds[0], temperature: 0, revision: 1,
        createdAt: new Date().toISOString(),
      };
      state.roles[roleId] = { id: roleId, name: "Recovery fixture nonadmin", description: "Exact platform-role negative test",
        permissions: ["provider:manage"], createdAt: new Date().toISOString() };
      state.users[userId] = { ...state.users.native_owner, id: userId, email: "recovery-negative@example.test", roleId };
    }));
    seeded = true;
    const login = await checked("/api/auth/login", "POST", {
      email: "native@example.test", password: "Synthetic-local-only-2026!",
    }, 200, false);
    assert.equal(login.data.user.id, "native_owner");
    assert.equal((await checked("/api/auth/me", "GET")).data.id, "native_owner");
    assert.equal((await checked("/api/providers", "GET")).data.length, 2);
    await checked("/api/providers", "GET", undefined, 401, false);
    await checked("/api/providers", "GET", undefined, 403, userId);
    const rotated = await checked("/api/auth/refresh", "POST", { refreshToken: login.data.refreshToken }, 200, false);
    await checked("/api/auth/refresh", "POST", { refreshToken: login.data.refreshToken }, 401, false);
    await checked("/api/auth/logout", "POST", { refreshToken: rotated.data.refreshToken });

    const beforeInvalid = await access(repository => repository.readAuthoritative(state => structuredClone(state.providers)));
    await checked(`/api/providers/${legacyIds[1]}/activate`, "POST", {}, 422);
    assert.deepEqual(await access(repository => repository.readAuthoritative(state => state.providers)), beforeInvalid);
    const input = { name: "Repaired native recovery fixture", type: "openai_compatible", baseUrl: fixture.baseUrl,
      apiKey: "", model: nativeModelIds[0], temperature: 0 };
    const edited = await checked(`/api/providers/${legacyIds[0]}`, "PUT", input);
    assert.equal(edited.data.type, "openai_compatible");
    assert.equal(fixture.calls.length, 0, "Login/configuration edit made an inference request");
    const created = await checked("/api/providers", "POST", { ...input, name: "Selected native recovery replacement", apiKey: fixture.apiKey }, 201);
    ownedIds.add(created.data.id);
    assert.equal(fixture.calls.length, 0, "Provider creation made an inference request");
    const tested = await checked(`/api/providers/${created.data.id}/test`, "POST", {});
    assert.equal(tested.data.ok, true); assert.equal(tested.data.model, nativeModelIds[0]);
    assert.equal(fixture.calls.length, 1); assert.equal(fixture.calls[0].system, "provider-test");
    assert.equal(await access(repository => repository.readAuthoritative(state => Object.values(state.providers).filter(item => item.active === true).length)), 2,
      "An explicit provider probe changed the active selection");
    const selected = await checked(`/api/providers/${created.data.id}/activate`, "POST", {});
    assert.equal(selected.meta.activationScope, "stored-configuration");
    assert.equal(selected.meta.runtimeActivationConfirmed, false);
    assert.equal(selected.meta.remoteCompatibilityConfirmed, false);
    assert.equal(fixture.calls.length, 1, "Stored selection made another inference request");
    const saved = await access(repository => repository.readAuthoritative(state => ({
      active: Object.values(state.providers).filter(item => item.active === true).map(item => item.id),
      probes: Object.values(state.invocationProvenance).filter(item => item.providerId === created.data.id && item.promptTemplateVersion === "prompt/provider-test/v1"),
    })));
    assert.deepEqual(saved.active, [created.data.id]); assert.equal(saved.probes.length, 1);
    assert.equal(saved.probes[0].status, "SUCCEEDED"); assert.equal(saved.probes[0].measured, true);
    accepted = true;
  } finally {
    // Only after acceptance remove our exact synthetic identities/configurations.
    // Keep audit/provenance and any failed state; never restore an old whole image.
    try {
      if (seeded && accepted) await access(repository => repository.mutate(state => {
        for (const id of ownedIds) delete state.providers[id];
        delete state.users[userId]; delete state.roles[roleId];
      }));
    } finally { await fixture.close(); }
  }
  console.log(JSON.stringify({ profile: "native-control-plane-recovery/v1", passed: true,
    identityRecovery: true, refreshReplayDenied: true, authenticationAndPlatformRoleRetained: true,
    invalidSelectionUnchanged: true, legacyEditRecovered: true, multipleActiveRepaired: true,
    selectionScope: "stored-configuration", inferenceScope: "one fixed public loopback probe",
    runtimeActivationConfirmed: false, externalProviderQualified: false, ownerRecordsChanged: false }));
}

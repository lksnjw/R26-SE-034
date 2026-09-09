import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { hostingBindings, generateHostingConfig } from "./hosting-config.mjs";
import { assertRelease, jsonHash } from "./hosting-artifact.mjs";

const cloud = { LCWE_FIREBASE_PROJECT_ID: "example-approved-project", VITE_API_BASE_URL: "https://backend.example.test/api", VITE_WS_BASE_URL: "wss://backend.example.test/ws" };
const local = { LCWE_HOSTING_EMULATOR: "1", VITE_API_BASE_URL: "http://127.0.0.1:8081/api", VITE_WS_BASE_URL: "ws://127.0.0.1:8081/ws" };
test("explicit cloud and demo bindings are different release classes", () => {
  assert.equal(hostingBindings(cloud).emulatorOnly, false);
  assert.equal(hostingBindings(local).projectId, "demo-lcwe-hosting");
  assert.equal(hostingBindings(local).config.pipelineUploadEnabled, false);
  assert.equal(hostingBindings({ ...cloud, VITE_SENTRY_DSN: "" }).publicEnv.VITE_SENTRY_DSN, undefined);
});
for (const [name, patch] of Object.entries({ missingProject: { LCWE_FIREBASE_PROJECT_ID: "" }, missingApi: { VITE_API_BASE_URL: undefined }, missingWs: { VITE_WS_BASE_URL: undefined }, insecureApi: { VITE_API_BASE_URL: "http://backend.example.test/api" }, loopbackCloud: { VITE_API_BASE_URL: "http://127.0.0.1:8081/api" }, token: { VITE_WS_BASE_URL: "wss://backend.example.test/ws?secret=one" }, publicSecret: { VITE_ERP_API_KEY: "private" }, demoCloud: { LCWE_FIREBASE_PROJECT_ID: "demo-lcwe-hosting" }, wrongPath: { VITE_API_BASE_URL: "https://backend.example.test" } }))
  test(`${name} fails before build or network access`, () => assert.throws(() => hostingBindings({ ...cloud, ...patch })));
test("emulator builds cannot use any remote backend or real Firebase project", () => {
  assert.throws(() => hostingBindings({ ...local, VITE_API_BASE_URL: cloud.VITE_API_BASE_URL }));
  assert.throws(() => hostingBindings({ ...local, LCWE_FIREBASE_PROJECT_ID: cloud.LCWE_FIREBASE_PROJECT_ID }));
});
test("generated headers bind exact backend origins without credentials or wildcard CSP", async () => {
  const base = JSON.parse(await readFile(new URL("../../firebase.json", import.meta.url), "utf8"));
  const generated = generateHostingConfig(base, hostingBindings(cloud));
  assert.equal(generated.hosting.public, "public");
  assert.equal(base.hosting.public, "frontend/dist");
  const csp = generated.hosting.headers[0].headers.find(header => header.key === "Content-Security-Policy").value;
  assert.match(csp, /connect-src 'self' .* https:\/\/backend\.example\.test wss:\/\/backend\.example\.test;/);
  assert.equal(csp.includes("*"), false); assert.equal(csp.includes("'unsafe-eval'"), false);
});
test("RE2-compatible rewrite allowlist supports Windows and URL paths, not private/API namespaces", async () => {
  const base = JSON.parse(await readFile(new URL("../../firebase.json", import.meta.url), "utf8"));
  const pattern = new RegExp(base.hosting.rewrites[0].regex);
  for (const path of ["/", "/chat", "/chat/session", "/settings/providers", "/profile/security", "/login"]) {
    assert.equal(pattern.test(path), true); assert.equal(pattern.test(path.replaceAll("/", "\\")), true);
  }
  for (const path of ["/api", "/api/missing", "/ws", "/assets/missing.js", "/.env", "/.git/config", "/activity", "/chatty", "/a-missing-screen"]) {
    assert.equal(pattern.test(path), false); assert.equal(pattern.test(path.replaceAll("/", "\\")), false);
  }
});
test("release guard rejects changed source/assets/config and wrong deployment identity", async () => {
  const base = JSON.parse(await readFile(new URL("../../firebase.json", import.meta.url), "utf8"));
  const bindings = hostingBindings(cloud), config = generateHostingConfig(base, bindings);
  const assets = { records: [{ path: "index.html", sha256: "fixture" }], totalBytes: 1, fingerprint: "fixture" };
  const manifest = { profile: "firebase-hosting-release/v1", bindings, configFingerprint: jsonHash(config), sourceFingerprint: "source", assets };
  const inputs = { manifest, config, base, assets, sourceFingerprint: "source", deployProject: cloud.LCWE_FIREBASE_PROJECT_ID };
  assert.deepEqual(assertRelease(inputs), bindings);
  assert.throws(() => assertRelease({ ...inputs, deployProject: "other-approved-project" }), /project does not match/);
  assert.throws(() => assertRelease({ ...inputs, sourceFingerprint: "changed" }), /Sources changed/);
  assert.throws(() => assertRelease({ ...inputs, assets: { ...assets, totalBytes: 2 } }), /files changed/);
  assert.throws(() => assertRelease({ ...inputs, config: { ...config, hosting: { ...config.hosting, public: "../backend-ts" } } }), /configuration changed/);
});
test("a verified demo artifact is still refused by the actual deployment guard", async () => {
  const base = JSON.parse(await readFile(new URL("../../firebase.json", import.meta.url), "utf8"));
  const bindings = hostingBindings(local), config = generateHostingConfig(base, bindings), assets = { records: [], totalBytes: 0, fingerprint: "fixture" };
  const manifest = { profile: "firebase-hosting-release/v1", bindings, configFingerprint: jsonHash(config), sourceFingerprint: "source", assets };
  const inputs = { manifest, config, base, assets, sourceFingerprint: "source" };
  assert.deepEqual(assertRelease(inputs), bindings);
  assert.throws(() => assertRelease({ ...inputs, deployProject: "demo-lcwe-hosting" }), /cannot be deployed/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Fixed loopback only; never take a production URL from the environment.
const base = "http://127.0.0.1:23571";
const manifest = JSON.parse(await readFile(new URL("../.hosting/release-manifest.json", import.meta.url), "utf8"));
assert.equal(manifest.bindings.emulatorOnly, true, "Use an isolated emulator artifact");
const request = path => fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(5000) });
const shell = await (await request("/")).text(); assert.match(shell, /id="root"/);
for (const path of ["/chat", "/chat/saved-chat", "/workflows/saved-workflow", "/builder/workflow", "/executions/run", "/settings", "/settings/providers", "/login", "/unauthorized", "/profile/security"]) {
  const response = await request(path);
  assert.equal(response.status, 200, `Deep link ${path}`); assert.equal(await response.text(), shell);
  assert.match(response.headers.get("cache-control"), /no-cache/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy"), /connect-src 'self'.*http:\/\/127\.0\.0\.1:8081/);
}
for (const path of ["/api", "/api/missing", "/api/pipeline/v1/jobs/nope", "/ws", "/ws/events", "/assets/missing.js", "/src/config/app.js", "/node_modules/package", "/.env", "/.env.hosting.local", "/.git/config", "/activity", "/a-missing-screen"]) {
  const response = await request(path);
  assert.equal(response.status, 404, `Private/API path ${path} must not return the SPA`);
  assert.notEqual(await response.text(), shell);
}
for (const method of ["POST", "PATCH", "DELETE"]) {
  const response = await fetch(`${base}/api/missing`, { method, signal: AbortSignal.timeout(5000) });
  assert.ok(response.status >= 400); assert.notEqual(await response.text(), shell);
}
const asset = manifest.assets.records.find(record => /^assets\/.+-[A-Za-z0-9_-]{8,}\.js$/.test(record.path));
assert.ok(asset);
const response = await request(`/${asset.path}`);
assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /immutable/);
assert.equal((await response.arrayBuffer()).byteLength, asset.bytes);
console.log("Actual Firebase Hosting emulator passed: 10 deep links, 13 API/private/removed/unknown misses, 3 write-method misses, immutable asset, CSP and revalidation headers. No backend/ERP effects dispatched.");

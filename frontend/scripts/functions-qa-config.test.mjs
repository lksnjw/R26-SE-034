import assert from "node:assert/strict";
import { test } from "node:test";
import config, { functionsQaPrefix } from "../vite.functions-qa.config.js";

test("native browser QA ignores owner env and pins one loopback demo Functions origin", () => {
  const value = config({ command: "serve", mode: "development", isSsrBuild: false, isPreview: false });
  assert.equal(value.envDir, false); assert.equal(value.envPrefix, "LCWE_PRESENTATION_");
  assert.equal(value.server.host, "127.0.0.1"); assert.equal(value.server.port, 5192); assert.equal(value.server.strictPort, true);
  assert.deepEqual(Object.keys(value.server.proxy), ["/api"]); const proxy = value.server.proxy["/api"];
  assert.equal(proxy.target, "http://127.0.0.1:23675"); assert.equal(proxy.changeOrigin, true);
  assert.equal(proxy.rewrite("/api/auth/login"), `${functionsQaPrefix}/api/auth/login`);
  assert.equal(proxy.rewrite("/api/executions/original/events?after=3&waitMs=8000"), `${functionsQaPrefix}/api/executions/original/events?after=3&waitMs=8000`);
  assert.equal(value.server.proxy["/ws"], undefined, "Unqualified streaming must not silently fall back to a resident backend");
});

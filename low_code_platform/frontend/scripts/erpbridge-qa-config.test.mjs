import { test } from "node:test";
import assert from "node:assert/strict";
import configure from "../vite.erpbridge-qa.config.js";
import configureMerges from "../vite.erpbridge-merge-qa.config.js";

test("Docker QA uses separate loopback ports and no owner env or direct ERP proxy", () => {
  const config = configure({ command: "serve", mode: "development" });
  assert.equal(config.envDir, false);
  assert.equal(config.envPrefix, "LCWE_DOCKER_QA_");
  assert.equal(config.server.host, "127.0.0.1");
  assert.equal(config.server.port, 5174);
  assert.equal(config.server.strictPort, true);
  assert.deepEqual(Object.keys(config.server.proxy), ["/api", "/ws"]);
  assert.equal(config.server.proxy["/api"].target, "http://127.0.0.1:8082");
  assert.equal(config.server.proxy["/ws"].target, "ws://127.0.0.1:8082");
});

test("merge QA preserves loopback/no-owner-env boundaries and routes only application API/socket", () => {
  const config = configureMerges({ command: "serve", mode: "development" });
  assert.equal(config.envDir, false); assert.equal(config.envPrefix, "LCWE_DOCKER_QA_");
  assert.equal(config.server.host, "127.0.0.1"); assert.equal(config.server.port, 5180); assert.equal(config.server.strictPort, true);
  assert.deepEqual(Object.keys(config.server.proxy), ["/api", "/ws"]);
  assert.equal(config.server.proxy["/api"].target, "http://127.0.0.1:8088"); assert.equal(config.server.proxy["/ws"].target, "ws://127.0.0.1:8088");
});

import { beforeEach, expect, test, vi } from "vitest";
import { discoverTools, invalidateToolDiscoveryCache } from "../src/agent/tool-discovery.js";
import { toolSchema } from "../src/registry/schemas.js";
import type { RegistryService } from "../src/registry/service.js";
import type { ErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";

const schema = { type: "object", properties: { id: { type: "string" } } };
const tool = toolSchema.parse({ tool_id: "read-1", name: "read", mcp_tool_name: "finance.read", input_schema: schema, allowed_roles: ["Client"], is_read_only: true });
const registry = (tools = [tool], hash = "registry-1") => ({ hash: () => hash, snapshot: () => ({ tools }) }) as unknown as RegistryService;
const session = (listTools: () => Promise<unknown>) => ({ listTools }) as unknown as ErpbridgeMcpSession;
beforeEach(invalidateToolDiscoveryCache);

test("discovery admits only exact registered schema matches, not remote-only names", async () => {
  const bridge = session(async () => [{ name: "finance.read", inputSchema: schema }, { name: "unknown.write", inputSchema: schema }]);
  expect(await discoverTools(bridge, registry())).toEqual([tool]);
  expect(await discoverTools(bridge, registry([{ ...tool, input_schema: { type: "object", properties: {} } }], "changed"))).toEqual([]);
});

test("cache is isolated by connection and local registry revision", async () => {
  const first = vi.fn(async () => [{ name: "finance.read", inputSchema: schema }]);
  const second = vi.fn(async () => []);
  const a = session(first), b = session(second);
  expect(await discoverTools(a, registry())).toEqual([tool]);
  expect(await discoverTools(b, registry())).toEqual([]);
  await discoverTools(a, registry());
  expect(first).toHaveBeenCalledTimes(1);
  await discoverTools(a, registry([], "changed"));
  expect(first).toHaveBeenCalledTimes(2);
});

test("incomplete local identity or grants never become admitted through discovery", async () => {
  const bridge = session(async () => [{ name: "finance.read", inputSchema: schema }]);
  for (const incomplete of [{ ...tool, tool_id: "" }, { ...tool, allowed_roles: [] }, { ...tool, input_schema: {} }]) {
    invalidateToolDiscoveryCache();
    expect(await discoverTools(bridge, registry([incomplete]))).toEqual([]);
  }
});

test("failed discovery is explicit and is not cached as a healthy empty connection", async () => {
  const list = vi.fn().mockRejectedValueOnce(new Error("credential detail")).mockResolvedValue([{ name: "finance.read", inputSchema: schema }]);
  const bridge = session(list);
  await expect(discoverTools(bridge, registry())).rejects.toThrow("ERPBridge tool discovery failed");
  expect(await discoverTools(bridge, registry())).toEqual([tool]);
});

test("duplicate remote names fail closed and missing session does not contaminate caches", async () => {
  expect(await discoverTools(null, registry())).toEqual([]);
  const bridge = session(async () => [{ name: "finance.read", inputSchema: schema }, { name: "finance.read", inputSchema: schema }]);
  await expect(discoverTools(bridge, registry())).rejects.toThrow("ERPBridge tool discovery failed");
});

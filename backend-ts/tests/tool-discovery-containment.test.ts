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

test("a 128-tool ERP catalog remains exact, complete and cached without broadening authority", async () => {
  const tools = Array.from({ length: 128 }, (_, index) => toolSchema.parse({ ...tool,
    tool_id: `read-${String(index + 1).padStart(3, "0")}`,
    name: `read_${String(index + 1).padStart(3, "0")}`,
    mcp_tool_name: `finance.read_${String(index + 1).padStart(3, "0")}`,
  }));
  const listTools = vi.fn(async () => tools.map(value => ({ name: value.mcp_tool_name, inputSchema: schema })));
  const bridge = session(listTools), catalog = registry(tools, "registry-128");
  const discovered = await discoverTools(bridge, catalog);
  expect(discovered).toHaveLength(128);
  expect(new Set(discovered.map(value => value.tool_id)).size).toBe(128);
  expect(discovered.map(value => value.tool_id)).toEqual(tools.map(value => value.tool_id));
  expect(await discoverTools(bridge, catalog)).toEqual(discovered);
  expect(listTools).toHaveBeenCalledTimes(1);
});

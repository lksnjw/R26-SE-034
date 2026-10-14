import { expect, test, vi } from "vitest";
import { validateSemantics } from "../src/governance/semantic-validator.js";
import type { ErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.js";
const context = { toolName: "fixture.read", toolDisplayName: "Read", arguments: {}, userRole: "Workflow Builder", userId: "fixture" };
function session(result: unknown, present = true) {
  return { listTools: vi.fn(async () => present ? [{ name: "check_policy.rev_MS4wLjA", inputSchema: { type: "object" } }] : []), callToolDirect: vi.fn(async () => result) } as unknown as ErpbridgeMcpSession;
}
test.each([{ content: [], isError: true }, { content: [] }, { allowed: "true" }, { decision: "conditional" }, { content: [{ type: "text", text: '{"allowed":false}' }] }, { content: [{ type: "text", text: '{"allowed":false}' }], structuredContent: { allowed: true } }])("present MCP policy failure/malformed/conditional/conflicting decision never falls through %#", async result => {
  expect(await validateSemantics(context, session(result))).toMatchObject({ allowed: false, source: "mcp_policy" });
});
test("MCP policy absence is optional, explicit allowance is decoded, and discovery/dispatch failure denies", async () => {
  expect(await validateSemantics(context, session({}, false))).toEqual({ allowed: true, source: "default_allow" });
  expect(await validateSemantics(context, session({ content: [], structuredContent: { allowed: true } }))).toMatchObject({ allowed: true, source: "mcp_policy" });
  for (const operation of ["listTools", "callToolDirect"] as const) {
    const s = session({ allowed: true }); vi.mocked(s[operation]).mockRejectedValueOnce(new Error("private failure"));
    const result = await validateSemantics(context, s); expect(result).toMatchObject({ allowed: false, source: "mcp_policy" }); expect(result.reason).not.toContain("private");
  }
});

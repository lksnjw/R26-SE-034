import { describe, expect, test, vi } from "vitest";
import { checkErpPolicy } from "../src/governance/rbac.js";

const params = { userId: "user", userRole: "Client", action: "payment.send", context: { amount: 10 } };
describe("required ERP policy decision", () => {
  test("missing service and failed request deny execution", async () => {
    expect((await checkErpPolicy(undefined, params)).allowed).toBe(false);
    expect((await checkErpPolicy({ callToolDirect: async () => { throw new Error("secret network error"); } }, params)).allowed).toBe(false);
  });
  test.each([null, [], {}, "allow", { allowed: "false" }, { allowed: 1 }, { result: "unknown" }, { decision: "conditional", conditions: ["manager approval"] }, { recommended_decision: "allow" }])("rejects malformed, advisory, or conditional decision %j", async (response) => {
    expect((await checkErpPolicy({ callToolDirect: async () => response }, params)).allowed).toBe(false);
  });
  test.each([{ allowed: true }, { decision: "approved" }, { result: "allow" }])("accepts explicit authorization %j", async (response) => {
    const callToolDirect = vi.fn(async () => response);
    expect((await checkErpPolicy({ callToolDirect }, params)).allowed).toBe(true);
    expect(callToolDirect).toHaveBeenCalledWith("policy-gate-evaluate", expect.objectContaining({ actor: { id: "user", role: "Client" }, context: { amount: 10 } }));
  });
  test.each([
    { content: [{ type: "text", text: '{"allowed":true}' }] },
    { content: [], structuredContent: { decision: "approved" } },
    { content: [{ type: "text", text: "Approved operation" }], structuredContent: { allowed: true } },
    { content: [{ type: "text", text: '{"allowed":true}' }], structuredContent: { allowed: true }, isError: false },
  ])("accepts explicit decisions inside MCP envelopes %j", async (response) => {
    expect((await checkErpPolicy({ callToolDirect: async () => response }, params)).allowed).toBe(true);
  });
  test.each([
    { allowed: true, decision: "denied" },
    { allowed: true, conditions: ["manager approval"] },
    { content: [], allowed: true },
    { content: [], structuredContent: { allowed: true }, isError: true },
    { content: [{ type: "text", text: '{"allowed":false}' }], structuredContent: { allowed: true } },
    { content: [{ type: "text", text: '{"allowed":true}' }, { type: "text", text: '{"allowed":false}' }] },
    { content: [{ type: "text", text: "allow" }] },
    { content: [{ type: "image", text: '{"allowed":true}' }] },
    { content: [], structuredContent: { content: [], structuredContent: { allowed: true } } },
    { content: [], structuredContent: { allowed: true }, isError: "false" },
  ])("rejects ambiguous, failed or invalid MCP authority %j", async (response) => {
    expect((await checkErpPolicy({ callToolDirect: async () => response }, params)).allowed).toBe(false);
  });
});

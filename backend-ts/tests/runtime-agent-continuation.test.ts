import { expect, test, vi } from "vitest";
import { runRuntimeAgent } from "../src/runner/runtime-agent.js";
import { OpenAICompatibleClient } from "../src/providers/openai-compatible.js";
import type { ProviderRuntime } from "../src/providers/runtime.js";
import type { OperationAgentNode } from "../src/workflows/compiled-read.js";
import { protectedSimulationRead as read } from "./fixtures/protected-simulation.js";
import { exactBridgeName } from "../src/tools/erpbridge-contract.js";
import { capabilityContractHash } from "../src/registry/capability-admission.js";

test("ordinary runtime agent echoes private continuation in the next model round but not its public answer/hooks events", async () => {
  const contractHash = capabilityContractHash(read), details = [{ type: "reasoning.encrypted", data: "private-agent-marker==", signature: "opaque==" }];
  const node: OperationAgentNode = { id: "agent", kind: "agent", instruction: "Read once and return complete", input: { kind: "ref", source: "workflowInput", path: [] },
    allowedCapabilities: [{ toolId: read.tool_id, action: read.name, remoteName: exactBridgeName(read), contractHash,
      admission: { connectionId: "fixture", capabilityId: "capability", revisionId: "revision", admissionVersion: 1, contractHash } }],
    outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
    completionPredicate: { path: ["text"], equals: "complete" }, model: "fixture-model", dataClass: "restricted", maxInputChars: 20000,
    maxInputItems: 200, maxOutputTokens: 1024, maxTotalTokens: 4096, maxRounds: 4, maxToolCalls: 4, maxWallTimeMs: 30000 };
  const send = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: null,
    reasoning_details: details, tool_calls: [{ id: "call-A", type: "function", function: { name: exactBridgeName(read), arguments: '{"id":"A"}' } }] } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }))
    .mockResolvedValueOnce(Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"text":"complete"}' } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
  const client = new OpenAICompatibleClient({ baseURL: "https://model.example.invalid/v1", model: node.model!, apiKey: "fixture-only", fetchImplementation: send });
  const callTool = vi.fn(async () => ({ content: [], structuredContent: { text: "Verified A" } }));
  const afterTool = vi.fn(async () => {}), afterModel = vi.fn(async () => {});
  const result = await runRuntimeAgent({ node, taskInput: {}, runtime: { queryWithTools: client.queryWithTools.bind(client) } as unknown as ProviderRuntime,
    tools: [structuredClone(read)], workflowId: "flow", executionId: "run", actor: { id: "owner", role: "admin" },
    hooks: { beforeModel: async () => {}, afterModel, callTool, afterTool } });
  expect(result.output).toEqual({ text: "complete" }); expect(callTool).toHaveBeenCalledTimes(1);
  const wire = JSON.parse(String(send.mock.calls[1]![1]!.body));
  expect(wire.messages[2].reasoning_details).toEqual(details); expect(wire.messages[3].tool_call_id).toBe("call-A");
  expect(JSON.stringify(result)).not.toMatch(/private-agent-marker|providerContinuationSecret|reasoning_details/);
  expect(JSON.stringify(afterTool.mock.calls)).not.toContain("private-agent-marker");
  // The internal afterModel hook receives the turn; production hooks must not
  // publish that private object. Public operation events are tested separately.
  expect(afterModel).toHaveBeenCalledTimes(2);
});

import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import { OpenAICompatibleClient } from "../src/providers/openai-compatible.js";
import { LOCAL_POLICY_SYSTEM_PROMPT, LOCAL_POLICY_V2_SYSTEM_PROMPT, systemInstructionsFor } from "../src/prompts/contracts.js";

test("historical local-policy/v1 stays byte-for-byte stable; v2 is separately versioned", () => {
  expect(createHash("sha256").update(LOCAL_POLICY_SYSTEM_PROMPT).digest("hex")).toBe("1bde7a72d208988aedaf270fa7c83c25b0f04ae89664eca30b83045f8a04da8e");
  expect(systemInstructionsFor("prompt/local-policy/v1")).toBe(LOCAL_POLICY_SYSTEM_PROMPT);
  expect(systemInstructionsFor("prompt/local-policy/v2")).toBe(LOCAL_POLICY_V2_SYSTEM_PROMPT);
  expect(LOCAL_POLICY_V2_SYSTEM_PROMPT).toContain("unapplied_node_proposal");
});

test.each([
  ["https://openrouter.ai/api/v1", "deepseek/deepseek-v4.1-flash", "prompt/local-policy/v2", true],
  ["https://openrouter.ai.evil.test/api/v1", "deepseek/deepseek-v4.1-flash", "prompt/local-policy/v2", false],
  ["https://evil.test/openrouter.ai/api/v1", "deepseek/deepseek-v4.1-flash", "prompt/local-policy/v2", false],
  ["http://openrouter.ai/api/v1", "deepseek/deepseek-v4.1-flash", "prompt/local-policy/v2", false],
  ["https://openrouter.ai:443/api/v1", "deepseek/deepseek-v4.1-flash", "prompt/local-policy/v2", false],
  ["https://openrouter.ai/api/v1?flag=1", "deepseek/deepseek-v4.1-flash", "prompt/local-policy/v2", false],
  ["https://openrouter.ai/api/v1", "deepseek/deepseek-v4.1-flash-extra", "prompt/local-policy/v2", false],
  ["https://openrouter.ai/api/v1", "deepseek/deepseek-v4.1-flash", "prompt/local-policy/v1", false],
  ["https://openrouter.ai/api/v1", "deepseek/deepseek-v4.1-flash", "prompt/candidate/v20", false],
])("policy wire profile routes by exact endpoint/model/version: %s %s %s", async (baseURL, model, version, qualified) => {
  const send = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"decision":"review","reason":"Specific fact required"}' } }] }));
  const client = new OpenAICompatibleClient({ baseURL, apiKey: "synthetic-key", model, fetchImplementation: send });
  await client.generate("{}", model, undefined, { promptTemplateVersion: version, maxOutputTokens: 1024 });
  const body = JSON.parse(String(send.mock.calls[0]![1]?.body));
  expect(body.max_tokens).toBe(1024);
  if (qualified) { expect(body.reasoning).toEqual({ enabled: false }); expect(body.response_format).toEqual({ type: "json_object" }); }
  else { expect(body).not.toHaveProperty("reasoning"); expect(body).not.toHaveProperty("response_format"); }
  expect(send).toHaveBeenCalledTimes(1);
});

test("unknown finish reason and invalid reasoning-token metadata cannot become arbitrary diagnostic text", async () => {
  const send = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ finish_reason: "private-finish", message: { content: "{}", reasoning_details: "private-reasoning" } }],
    usage: { prompt_tokens: 1, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: "private-token-text" } } }));
  const client = new OpenAICompatibleClient({ baseURL: "https://openrouter.ai/api/v1", apiKey: "synthetic-key", model: "deepseek/deepseek-v4.1-flash", fetchImplementation: send });
  const result = await client.generate("{}", "", undefined, { promptTemplateVersion: "prompt/local-policy/v2" });
  expect(result.generationDiagnostics).toEqual({ finishReason: "other", outputTokens: 2 }); expect(JSON.stringify(result)).not.toContain("private");
});

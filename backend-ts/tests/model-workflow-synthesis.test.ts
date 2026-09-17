import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { afterEach, expect, test, vi } from "vitest";
import { Repository } from "../src/repository/store.js";
import { RegistryService } from "../src/registry/service.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { toolSchema } from "../src/registry/schemas.js";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { SynthesisService } from "../src/synthesis/service.js";
import { compileOperationWorkflow, inspectModelWorkflowDraft } from "../src/workflows/compiled-read.js";
import { validateWorkspaceDraft } from "../src/workflows/draft-validation.js";
import { MODEL_WORKFLOW_CANDIDATE_SYSTEM_PROMPT, REVIEWED_SOURCE_CANDIDATE_SYSTEM_PROMPT, RECURRING_COMPOSITION_CANDIDATE_SYSTEM_PROMPT, generationPromptHash, systemInstructionsFor } from "../src/prompts/contracts.js";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
const read = toolSchema.parse({ tool_id: "synthetic-read", name: "records.read", mcp_tool_name: "records.read", is_read_only: true,
  allowed_roles: ["Platform Admin"], risk_level: "low", input_schema: { type: "object", properties: {}, additionalProperties: false },
  bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [],
    output_schema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false } } });
function blueprint(kind: "analysis" | "agent", patch: Record<string, unknown> = {}) {
  return { name: "Read and summarise", description: "Synthetic draft only, not a live model or execution", trigger: { type: "manual" }, steps: [
    { id: "records", action: read.name, parameters: {} },
    { id: "answer", kind, instruction: "Summarise the actual count", input: "{{records.structuredContent.count}}", data_class: "restricted" as const,
      max_input_items: 10, max_input_chars: 1000, max_output_tokens: 128,
      output_schema: { type: "object", properties: { summary: { type: "string" }, complete: { type: "boolean" } }, required: ["summary", "complete"], additionalProperties: false },
      ...(kind === "agent" ? { allowed_actions: [read.name], completion_predicate: { path: ["complete"], equals: true }, max_total_tokens: 512, max_rounds: 2, max_tool_calls: 1, max_wall_time_ms: 5000, max_concurrency: 1 } : {}), ...patch },
  ] };
}
async function setup(source: ReturnType<typeof blueprint>) {
  const directory = await mkdtemp(join(tmpdir(), "lcwe-model-draft-test-")); directories.push(directory);
  await writeFile(join(directory, "tools.json"), JSON.stringify([read])); await writeFile(join(directory, "rules.json"), "[]");
  const registries = await RegistryService.load(join(directory, "tools.json"), join(directory, "rules.json"));
  const repository = new Repository(null), validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
  const yaml = stringify(source), fetcher = vi.fn<typeof fetch>(async () => Response.json({ choices: [{ message: { content: yaml } }], usage: { prompt_tokens: 5, completion_tokens: 8 } }));
  const runtime = new ProviderRuntime(repository, executor, fetcher);
  runtime.activate({ id: "fixture", name: "Fixture", type: "openai_compatible", baseURL: "https://fixture.invalid/v1", apiKey: "fixture-only", model: "fixture-pinned-1", timeoutMs: 1000, temperature: 0,
    egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://fixture.invalid", interactiveDataClasses: ["restricted"], runtimeAnalysisDataClasses: [], runtimeAgentDataClasses: [], reviewedAt: "2026-10-08T00:00:00Z", reviewedBy: { id: "qa", name: "Synthetic reviewer" } } });
  return { registries, repository, validator, runtime, fetcher, yaml, service: new SynthesisService(runtime, registries, validator) };
}

test.each(["analysis", "agent"] as const)("v9 proposes a bounded %s draft without effect, admission or execution authority", async kind => {
  const source = blueprint(kind), s = await setup(source);
  const result = await s.service.synthesize({ prompt: "Create a workflow to read the actual count and summarise it", userRole: "Platform Admin", liveTools: [read] });
  expect(result.yaml).toBe(s.yaml.trim()); expect(result.execution_profile_issues).toEqual([]); expect(result.validation.passed).toBe(true);
  expect(result.candidate.generation_metadata.promptTemplateVersion).toBe("prompt/candidate/v9"); expect(s.fetcher).toHaveBeenCalledOnce();
  const body = JSON.parse(String(s.fetcher.mock.calls[0]![1]?.body));
  expect(body.messages[0].content).toBe(REVIEWED_SOURCE_CANDIDATE_SYSTEM_PROMPT);
  expect(result.candidate.generation_metadata.promptSha256).toBe(generationPromptHash(body.messages[1].content, "prompt/candidate/v9"));
  const saved = await s.repository.snapshot(); expect(saved.executions).toEqual({}); expect(saved.workflows).toEqual({}); expect(saved.capabilityAdmissions).toEqual({});
  expect(inspectModelWorkflowDraft(source, [read], "Platform Admin")).toEqual([]);
  expect(() => compileOperationWorkflow(s.yaml, [read], "Platform Admin", new Map())).toThrow(/reviewed capability pin/);
  expect(validateWorkspaceDraft("qa", s.yaml, "Platform Admin", s.validator, [read]).passed).toBe(true);
});

test.each(["analysis", "agent"] as const)("%s candidate with an explicitly empty live catalog cannot use stale registered tools", async kind => {
  const s = await setup(blueprint(kind));
  const result = await s.service.synthesize({ prompt: "Read and summarise", userRole: "Platform Admin", liveTools: [] });
  expect(result.canExecute).toBe(false); expect(result.execution_profile_issues.length).toBeGreaterThan(0); expect(result.yaml).toBe(s.yaml.trim());
  const body = JSON.parse(String(s.fetcher.mock.calls[0]![1]?.body)); expect(JSON.parse(body.messages[1].content).TOOL_REGISTRY_JSON).toEqual([]);
});

test.each([
  ["missing output path", "analysis", { input: "{{records.structuredContent.missing}}" }],
  ["future output", "analysis", { input: "{{later.structuredContent.count}}" }],
  ["self reference", "agent", { input: "{{answer.structuredContent.summary}}" }],
  ["workflow input", "analysis", { input: "{{input.count}}" }],
  ["oversized instruction", "analysis", { instruction: "x".repeat(4001) }],
  ["zero item limit", "analysis", { max_input_items: 0 }],
  ["oversized output budget", "analysis", { max_output_tokens: 8193 }],
  ["unsupported schema constraint", "analysis", { output_schema: { type: "object", properties: { count: { type: "integer", minimum: 0 } } } }],
  ["floating model", "agent", { model: "example:latest" }],
  ["unoffered tool", "agent", { allowed_actions: ["email.send"] }],
  ["duplicate tools", "agent", { allowed_actions: [read.name, read.name] }],
  ["unknown completion field", "agent", { completion_predicate: { path: ["invented"], equals: true } }],
  ["excessive rounds", "agent", { max_rounds: 9 }],
  ["excessive total tokens", "agent", { max_total_tokens: 32769 }],
  ["token budget below output", "agent", { max_total_tokens: 127 }],
  ["excessive wall time", "agent", { max_wall_time_ms: 120001 }],
] as const)("%s is blocked during generation and draft validation without a model rewrite", async (_label, kind, patch) => {
  const s = await setup(blueprint(kind, patch));
  const result = await s.service.synthesize({ prompt: "Read and summarise", userRole: "Platform Admin", liveTools: [read] });
  expect(result.canExecute).toBe(false); expect(result.execution_profile_issues.length).toBeGreaterThan(0); expect(result.yaml).toBe(s.yaml.trim()); expect(s.fetcher).toHaveBeenCalledOnce();
  expect(result.validation.passed).toBe(false); expect(result.validation.failed_rules).toContain("WORKSPACE_READ_COMPILATION");
  const validation = validateWorkspaceDraft("qa", s.yaml, "Platform Admin", s.validator, [read]);
  expect(validation.passed).toBe(false); expect(validation.failed_rules).toContain("WORKSPACE_READ_COMPILATION");
  expect((await s.repository.snapshot()).executions).toEqual({});
});

test("new instructions preserve historical provenance and recurring request constraints", () => {
  expect(systemInstructionsFor("prompt/candidate/v7")).toBe(RECURRING_COMPOSITION_CANDIDATE_SYSTEM_PROMPT);
  expect(RECURRING_COMPOSITION_CANDIDATE_SYSTEM_PROMPT).not.toContain("MODEL NODES:");
  expect(systemInstructionsFor("prompt/candidate/v8")).toBe(MODEL_WORKFLOW_CANDIDATE_SYSTEM_PROMPT);
  expect(systemInstructionsFor("prompt/candidate/v9")).toBe(REVIEWED_SOURCE_CANDIDATE_SYSTEM_PROMPT);
  expect(MODEL_WORKFLOW_CANDIDATE_SYSTEM_PROMPT).not.toContain("MODEL_SOURCE_HINTS_JSON");
  for (const marker of ["MODEL_SOURCE_HINTS_JSON", "callerInputClass", "UNKNOWN", "not permission", "every allowed_actions"])
    expect(REVIEWED_SOURCE_CANDIDATE_SYSTEM_PROMPT).toContain(marker);
  for (const marker of ["no fake send", "data_class", "max_total_tokens", "SERVER_DERIVED_CONTEXT_JSON", "required_unresolved_requirements", "independent approvals", "never flatten", "use restricted"])
    expect(MODEL_WORKFLOW_CANDIDATE_SYSTEM_PROMPT).toContain(marker);
  expect(MODEL_WORKFLOW_CANDIDATE_SYSTEM_PROMPT).not.toContain("flat manual list of exact tool steps");
});

test.each(["analysis", "agent"] as const)("%s draft diagnostics reject model nodes inside read control flow and missing output contracts", kind => {
  const source = blueprint(kind);
  const structural = { ...source, metadata: { controlFlow: { schemaVersion: "read-control-flow/v1", root: { kind: "sequence", nodes: [{ kind: "action", nodeId: "records" }, { kind: "action", nodeId: "answer" }] } } } };
  expect(inspectModelWorkflowDraft(structural, [read], "Platform Admin").join(" ")).toMatch(/Operation control flow/);
  expect(inspectModelWorkflowDraft(source, [{ ...read, bridge_contract: undefined }], "Platform Admin").join(" ")).toMatch(/declared prior output/);
  expect(inspectModelWorkflowDraft(source, [read], "Client").join(" ")).toMatch(/role-granted/);
});

test("downstream tool bindings must match the declared model output type", () => {
  const source = blueprint("analysis");
  const target = toolSchema.parse({ ...read, tool_id: "target", name: "records.detail", mcp_tool_name: "records.detail", input_schema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false } });
  const combined = { ...source, steps: [...source.steps, { id: "detail", action: target.name, parameters: { value: "{{answer.structuredContent.summary}}" } }] };
  expect(inspectModelWorkflowDraft(combined, [read, target], "Platform Admin").length).toBeGreaterThan(0);
});

import { expect, test, vi } from "vitest";
import { resolve } from "node:path";
import { LOCAL_POLICY_V2_SYSTEM_PROMPT, QUERY_SYSTEM_PROMPT, promptData } from "../src/prompts/contracts.js";
import { runQueryLoop } from "../src/agent/query-loop.js";
import { queryChatPresentation } from "../src/agent/query-chat-presentation.js";
import { ProviderRuntime } from "../src/providers/runtime.js";
import { Repository } from "../src/repository/store.js";
import { RegistryService } from "../src/registry/service.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
// @ts-expect-error JavaScript operator-only harness, not application code.
import { assertNativePolicyConcurrencyScope, policyConcurrencyReportName, literalPolicyConcurrencyResponse, publicPolicyConcurrencyReport, finishNativePolicyQualification, policyConcurrencyRequest, policyConcurrencyAnswer, policyConcurrencyNoReadAnswer, assertPolicyConcurrencyAnswer } from "../scripts/native-functions-policy-concurrency-qa.mjs";
const config = { FIRESTORE_PROJECT_ID: "demo-lcwe-records", FIRESTORE_DATABASE_ID: "(default)", FIRESTORE_WORKSPACE_ID: `test_${"a".repeat(32)}_native`,
  LCWE_LOCAL_DOCKER_QA: "native-read/v1", ERPBRIDGE_BASE_URL: "http://127.0.0.1:18080", STORAGE_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"), FUNCTIONS_WRITER_ADMISSION_TIMEOUT_MS: "5000" };
const environment = { FIRESTORE_EMULATOR_HOST: "127.0.0.1:23671", GCLOUD_PROJECT: "demo-lcwe-records" };
function policyBody() { return { model: "local-planning-fixture", max_tokens: 1024, messages: [{ role: "system", content: LOCAL_POLICY_V2_SYSTEM_PROMPT },
  { role: "user", content: promptData({ policy: { version: "actual-file-version", role_access: { "Platform Admin": { blocked_tools: [] } } },
    actor: { id: "native_owner", role: "Platform Admin" }, request: policyConcurrencyRequest, action: "chat_request", context: { intent: "QUERY" } }) }] }; }

async function actualLiteralQueryPresentation() {
  const repository = await Repository.open(null);
  const registries = await RegistryService.load(resolve("tests/fixtures/chat-read-tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, repository), executor = new Executor(new ToolRegistry(), validator);
  const transport = vi.fn<typeof fetch>(async (_url, init) => Response.json(literalPolicyConcurrencyResponse(JSON.parse(String(init?.body))).result));
  const runtime = new ProviderRuntime(repository, executor, transport), tool = vi.fn(async () => { throw new Error("No tool belongs to this literal fixture"); });
  runtime.activate({ id: "literal-provider", name: "Literal provider", type: "openai_compatible", baseURL: "https://literal-query.example.test/v1", apiKey: "synthetic-key",
    model: "local-planning-fixture", temperature: 0, timeoutMs: 1000,
    egressPolicy: { profile: "model-egress-policy/v1", approvedOrigin: "https://literal-query.example.test", runtimeAnalysisDataClasses: [], interactiveDataClasses: ["restricted"],
      reviewedAt: "2026-10-13T00:00:00.000Z", reviewedBy: { id: "native_owner", name: "Native owner" } } });
  try {
    const result = await runQueryLoop({ userMessage: policyConcurrencyRequest, chatHistory: [], sessionId: "synthetic-session", actorId: "native_owner", actorRole: "Platform Admin" }, [], tool, runtime);
    expect(transport).toHaveBeenCalledTimes(1); expect(tool).not.toHaveBeenCalled();
    expect(result).toMatchObject({ stopReason: "COMPLETED", readOutcome: "NO_CONFIRMED_READ", narrativeRejected: true, toolSteps: [], toolCallLog: [] });
    const binding = runtime.binding!, presentation = queryChatPresentation("QUERY", policyConcurrencyRequest, binding, result);
    return { binding, answer: { text: result.text, modelBinding: presentation.answerBinding, artifacts: presentation.artifacts } };
  } finally { await repository.close(); }
}

test.each(["actual-server-presentation", "raw-literal-prose", "missing-routing", "wrong-requested-model", "fallback-claim", "fabricated-read", "draft-claim"])("native completion expectations qualify actual no-read server presentation (%s)", async scenario => {
  const actual = await actualLiteralQueryPresentation();
  const answer: any = structuredClone(actual.answer), observation: { completionCheck?: string } = {};
  if (scenario === "raw-literal-prose") answer.text = policyConcurrencyAnswer;
  if (scenario === "missing-routing") answer.modelBinding = actual.binding;
  if (scenario === "wrong-requested-model") answer.modelBinding.requestedModel = "other-model";
  if (scenario === "fallback-claim") answer.modelBinding.fallbackUsed = true;
  if (scenario === "fabricated-read") answer.artifacts.readOutcome = "READS_COMPLETED";
  if (scenario === "draft-claim") answer.artifacts.workflowDraft = "name: fabricated";
  if (scenario === "actual-server-presentation") {
    expect(answer.text).toBe(policyConcurrencyNoReadAnswer);
    expect(() => assertPolicyConcurrencyAnswer(answer, actual.binding, observation)).not.toThrow();
    expect(observation.completionCheck).toBe("answer_binding");
  } else {
    expect(() => assertPolicyConcurrencyAnswer(answer, actual.binding, observation)).toThrow();
    expect(observation.completionCheck).toBe(["missing-routing", "wrong-requested-model", "fallback-claim"].includes(scenario) ? "answer_binding" : "answer_presentation");
  }
});

test("policy harness accepts only the exact demo/emulator/Docker scope and no external inference credential", () => {
  expect(() => assertNativePolicyConcurrencyScope(config, environment)).not.toThrow();
  for (const changed of [{ ...environment, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }, { ...environment, GCLOUD_PROJECT: "owner-project" },
    { ...environment, GOOGLE_APPLICATION_CREDENTIALS: "owner.json" }, { ...environment, GENERATION_API_KEY: "owner-key" }])
    expect(() => assertNativePolicyConcurrencyScope(config, changed)).toThrow();
  for (const changed of [{ ...config, LCWE_LOCAL_DOCKER_QA: "native-operation/v1" }, { ...config, ERPBRIDGE_BASE_URL: "https://example.test" },
    { ...config, FIRESTORE_WORKSPACE_ID: "owner" }, { ...config, FUNCTIONS_WRITER_ADMISSION_TIMEOUT_MS: "30000" }])
    expect(() => assertNativePolicyConcurrencyScope(changed, environment)).toThrow();
});
test("policy report names are exclusive bounded labels, never owner-controlled paths", () => {
  expect(policyConcurrencyReportName()).toBe("native-held-policy-concurrency.json"); expect(policyConcurrencyReportName("t29-policy-1")).toBe("native-held-policy-concurrency-t29-policy-1.json");
  for (const label of ["", "../owner", "a/b", "a\\b", "A", "a".repeat(33), null, 1]) expect(() => policyConcurrencyReportName(label)).toThrow();
});
test("literal policy response requires the real exact prompt, 1024-token budget and original authenticated context", () => {
  const response = literalPolicyConcurrencyResponse(policyBody()); expect(response.kind).toBe("policy");
  expect(JSON.parse(response.result.choices[0].message.content)).toEqual({ decision: "allow", reason: "LOCAL literal transport fixture for the preflight concurrency gate." });
  const changes: Array<(body: ReturnType<typeof policyBody>) => void> = [body => { body.max_tokens = 1023; }, body => { body.model = "external-model"; }, body => { body.messages[0]!.content += " changed"; },
    body => { const input = JSON.parse(body.messages[1]!.content); input.actor.id = "other"; body.messages[1]!.content = JSON.stringify(input); },
    body => { const input = JSON.parse(body.messages[1]!.content); delete input.policy; body.messages[1]!.content = JSON.stringify(input); }];
  for (const change of changes) {
    const body = policyBody(); change(body); expect(() => literalPolicyConcurrencyResponse(body)).toThrow();
  }
});
test("the ordinary literal answer returns no tool calls and cannot substitute a different user request", () => {
  const body = { model: "local-planning-fixture", messages: [{ role: "system", content: QUERY_SYSTEM_PROMPT }, { role: "user", content: JSON.stringify({ USER_REQUEST: policyConcurrencyRequest }) }] };
  expect(literalPolicyConcurrencyResponse(body)).toMatchObject({ kind: "query", result: { choices: [{ finish_reason: "stop", message: { content: policyConcurrencyAnswer } }] } });
  expect(literalPolicyConcurrencyResponse({ ...body, messages: [{ role: "user", content: "Reply with exactly OK." }] }).kind).toBe("probe");
  expect(() => literalPolicyConcurrencyResponse({ ...body, messages: [...body.messages, { role: "tool", content: "rows" }] })).toThrow();
  expect(() => literalPolicyConcurrencyResponse({ ...body, messages: [body.messages[0], { role: "user", content: '{"USER_REQUEST":"other"}' }] })).toThrow();
});
test("public report projects only approved booleans counts timings and artifact hash", () => {
  const report = publicPolicyConcurrencyReport({ passed: false, causalPassed: true, fixtureDisposalConfirmed: false, stage: "fresh_readback", artifactSha256: "a".repeat(64),
    saveMs: 123, policyCalls: 1, distinctFreshOwner: true, switches: { remote: true, local: true, secret: "private" },
    rawPrompt: "PRIVATE PROMPT", apiKey: "PRIVATE KEY", response: "PRIVATE BODY", error: new Error("PRIVATE ERROR"), operationId: "PRIVATE ID", arbitrary: "PRIVATE" });
  expect(report).toMatchObject({ passed: false, causalPassed: true, fixtureDisposalConfirmed: false, artifactSha256: "a".repeat(64), saveMs: 123, policyCalls: 1, distinctFreshOwner: true, switches: { remote: true, local: true } });
  expect(JSON.stringify(report)).not.toContain("PRIVATE"); expect(JSON.stringify(report)).not.toContain("secret");
  expect(publicPolicyConcurrencyReport({ saveMs: -1, policyCalls: Infinity, stage: "PRIVATE ERROR", artifactSha256: "PRIVATE HASH" })).not.toHaveProperty("artifactSha256");
});

test("completion failure projection accepts only finite diagnostic labels and rejects secret or free text", () => {
  for (const completionCheck of ["completion_status", "operation_binding", "tool_attempts", "answer_presentation", "answer_binding", "policy_receipt", "provenance", "audit", "survival", "switches", "task_delivery", "duplicate_operation", "duplicate_delivery", "duplicate_no_calls", "fixture_counts"])
    expect(publicPolicyConcurrencyReport({ stage: "original_completion", completionCheck })).toMatchObject({ completionCheck });
  for (const completionCheck of ["PRIVATE KEY", "answer_presentation PRIVATE RESPONSE", "answer_binding\nPRIVATE ERROR", "", null, 1, {}, ["audit"], new Error("PRIVATE ERROR")]) {
    const report = publicPolicyConcurrencyReport({ stage: "original_completion", completionCheck });
    expect(report).not.toHaveProperty("completionCheck"); expect(JSON.stringify(report)).not.toContain("PRIVATE");
  }
});
test("cleanup releases the held request before close and preserves the exact original failure", async () => {
  const order: string[] = [], original = new Error("private original failure"), observation = { causalPassed: false, stage: "independent_save" }, reports: unknown[] = [];
  await expect(finishNativePolicyQualification({ barrier: { release: () => order.push("release") }, fixture: { close: async () => { order.push("close"); } }, observation,
    saveReport: async (report: unknown) => { order.push("report"); reports.push(report); } }, original)).rejects.toBe(original);
  expect(order).toEqual(["release", "close", "report"]); expect(reports[0]).toMatchObject({ passed: false, causalPassed: false, fixtureDisposalConfirmed: true, stage: "independent_save" });
});
test("successful assertions cannot claim acceptance while owned fixture cleanup rejects", async () => {
  const cleanup = new Error("private cleanup failure"), saveReport = vi.fn(async () => {});
  await expect(finishNativePolicyQualification({ barrier: { release: vi.fn() }, fixture: { close: async () => { throw cleanup; } },
    observation: { causalPassed: true, stage: "complete" }, saveReport })).rejects.toBe(cleanup);
  expect(saveReport).toHaveBeenCalledWith(expect.objectContaining({ passed: false, causalPassed: true, fixtureDisposalConfirmed: false }));
});
test("pending owned cleanup is awaited before report publication", async () => {
  let release!: () => void; const held = new Promise<void>(resolveHeld => { release = resolveHeld; }), saveReport = vi.fn(async () => {});
  const finishing = finishNativePolicyQualification({ barrier: { release: vi.fn() }, fixture: { close: () => held }, observation: { causalPassed: true, stage: "complete" }, saveReport });
  await Promise.resolve(); expect(saveReport).not.toHaveBeenCalled(); release(); await finishing;
  expect(saveReport).toHaveBeenCalledWith(expect.objectContaining({ passed: true, causalPassed: true, fixtureDisposalConfirmed: true }));
});
test("exclusive report-write failure cannot replace the retained primary error or become success", async () => {
  const original = new Error("original"), write = new Error("exclusive report already exists");
  const options = { barrier: { release: vi.fn() }, fixture: { close: async () => {} }, observation: { causalPassed: true, stage: "complete" }, saveReport: async () => { throw write; } };
  await expect(finishNativePolicyQualification(options, original)).rejects.toBe(original);
  await expect(finishNativePolicyQualification(options)).rejects.toBe(write);
});

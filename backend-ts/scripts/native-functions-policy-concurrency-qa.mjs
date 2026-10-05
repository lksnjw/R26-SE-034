// Operator-callable native QA only. Literal local inference responses qualify
// the preflight wait boundary, never model quality or dynamic policy decisions.
// Importing this module starts no server, seeds no data, and sends no request.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { stringify } from "yaml";
import { completionBarrier } from "./native-functions-cancellation-qa.mjs";
import { observeHeldMutation } from "./native-functions-concurrency-qa.mjs";
import { nativeModelIds } from "./native-functions-model-qa.mjs";
import { qaWorkflowBlueprint } from "./erpbridge-workspace-qa.mjs";
import { assertNativeDurabilityScope } from "./native-workspace-durability-qa.mjs";
import { assertChatTaskOutbox } from "../src/agent/chat-task-outbox.js";
import { LOCAL_POLICY_V2_SYSTEM_PROMPT } from "../src/prompts/contracts.js";

export const policyConcurrencyRequest = "Show me invoices";
export const policyConcurrencyAnswer = "LOCAL literal transport fixture: please provide the invoice identifier. No ERP operation was performed.";
export const policyConcurrencyNoReadAnswer = "No confirmed ERP data was retrieved. No email was sent, schedule activated or ERP change made.";
const fixtureModel = nativeModelIds[0];
const allowedStages = new Set(["scope", "configuration", "provider", "admission", "held_policy", "independent_save", "fresh_readback", "original_completion", "duplicate", "cleanup", "complete"]);
const allowedCompletionChecks = new Set(["completion_status", "operation_binding", "tool_attempts", "answer_presentation", "answer_binding", "policy_receipt", "provenance", "audit", "survival", "switches", "task_delivery", "duplicate_operation", "duplicate_delivery", "duplicate_no_calls", "fixture_counts"]);

/** Qualify the server's truthful presentation of a literal zero-read turn. */
export function assertPolicyConcurrencyAnswer(answer, binding, observation) {
  observation.completionCheck = "answer_presentation";
  assert(answer); assert.equal(answer.text, policyConcurrencyNoReadAnswer);
  assert.equal(answer.artifacts?.intent, "QUERY"); assert.equal(answer.artifacts?.readOutcome, "NO_CONFIRMED_READ");
  assert.equal(answer.artifacts?.narrativeRejected, true); assert.deepEqual(answer.artifacts?.sources, []); assert.deepEqual(answer.artifacts?.toolSteps, []);
  assert.equal(answer.artifacts?.boundHit, false); assert.equal(answer.artifacts?.iterationsUsed, 1); assert.equal(answer.artifacts?.workflowDraft, undefined);
  observation.completionCheck = "answer_binding";
  assert.equal(binding?.model, fixtureModel);
  const routing = { requestedModel: binding.model, model: binding.model, fallbackUsed: false };
  assert.deepEqual(answer.artifacts.modelRouting, routing);
  assert.deepEqual(answer.modelBinding, { ...binding, requestedModel: binding.model, fallbackUsed: false });
}
export function policyConcurrencyReportName(label) {
  assert(label === undefined || typeof label === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(label), "Use a bounded report label, never a path");
  return `native-held-policy-concurrency${label === undefined ? "" : `-${label}`}.json`;
}
export function assertNativePolicyConcurrencyScope(config, environment = process.env) {
  assertNativeDurabilityScope(config, environment);
  assert(!environment.GENERATION_API_KEY, "Remove external inference credentials from this literal fixture process");
  assert.equal(config.FUNCTIONS_WRITER_ADMISSION_TIMEOUT_MS, "5000", "Use the original diagnostic admission bound");
}
/** Classify only the exact supported requests. Keep raw input out of reports. */
export function literalPolicyConcurrencyResponse(body) {
  assert(body && typeof body === "object" && !Array.isArray(body));
  assert.equal(body.model, fixtureModel, "Only the original literal model is supported");
  assert(Array.isArray(body.messages) && body.messages.length > 0 && body.messages.length <= 100);
  const system = body.messages.find(message => message.role === "system")?.content;
  const user = body.messages.findLast(message => message.role === "user")?.content;
  let kind, text;
  if (user === "Reply with exactly OK.") { kind = "probe"; text = "OK"; }
  else if (system === LOCAL_POLICY_V2_SYSTEM_PROMPT) {
    assert.equal(body.max_tokens, 1024, "Policy output budget must be preserved");
    assert.equal(body.messages.length, 2); assert.equal(body.tools, undefined);
    const input = JSON.parse(user);
    assert.equal(input.actor?.id, "native_owner"); assert.equal(input.actor?.role, "Platform Admin");
    assert.equal(input.request, policyConcurrencyRequest); assert.equal(input.action, "chat_request"); assert.equal(input.context?.intent, "QUERY");
    assert(input.policy && typeof input.policy.version === "string" && input.policy.role_access && typeof input.policy.role_access === "object",
      "The actual local JSON policy and authenticated context must reach transport");
    kind = "policy"; text = '{"decision":"allow","reason":"LOCAL literal transport fixture for the preflight concurrency gate."}';
  } else {
    assert(typeof system === "string" && system.includes("TASK: READ-ONLY ERP QUESTION"), "Only the original query answer is supported");
    assert.equal(JSON.parse(user).USER_REQUEST, policyConcurrencyRequest);
    assert(!body.messages.some(message => message.role === "tool"), "This gate must not invoke a broker tool/policy path");
    kind = "query"; text = policyConcurrencyAnswer;
  }
  return { kind, result: { choices: [{ finish_reason: "stop", message: { content: text } }], usage: { prompt_tokens: 8, completion_tokens: 9 } } };
}
async function startPolicyFixture(config, barrier) {
  assertNativePolicyConcurrencyScope(config);
  const apiKey = randomBytes(32).toString("hex"), calls = [];
  let originalFailure, armed = false;
  const server = createServer(async (request, response) => {
    const reply = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { request.resume(); return reply(404, { error: "Literal fixture endpoint only" }); }
    if (request.headers.authorization !== `Bearer ${apiKey}`) { request.resume(); return reply(403, { error: "Literal fixture authorization required" }); }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; assert(size <= 256000, "Literal fixture request bound"); chunks.push(chunk); }
      const { kind, result } = literalPolicyConcurrencyResponse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      calls.push(kind);
      if (kind === "policy") {
        assert(armed, "Policy must belong to the admitted original task");
        assert.equal(calls.filter(value => value === "policy").length, 1, "Do not replay the original policy transport");
        await barrier.hold();
      }
      reply(200, result);
    } catch (error) { originalFailure ??= error; reply(422, { error: "Outside literal policy concurrency fixture scope" }); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise((resolveStarted, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveStarted); });
  return { apiKey, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, calls,
    arm() { assert(!armed); armed = true; }, assertHealthy() { if (originalFailure) throw originalFailure; },
    close() { return new Promise((resolveClosed, reject) => {
      const timer = setTimeout(() => { server.closeAllConnections(); reject(new Error("Literal policy fixture cleanup unconfirmed")); }, 1000);
      server.close(error => { clearTimeout(timer); error ? reject(error) : resolveClosed(); }); server.closeIdleConnections();
    }); } };
}
/** Explicit public projection: never serialize responses, prompts, IDs or errors. */
export function publicPolicyConcurrencyReport(observation) {
  const report = { profile: "native-held-policy-concurrency/v1", literalTransportFixture: true,
    scope: "actual local Functions/Admin/encrypted Firestore with configured local-policy evaluator; synthetic HTTP allow and no-tool answer only",
    limits: "Not real inference, dynamic policy quality, broker-policy wait, ERP rows/effects, native synchronous owner-at-entry inspection, or performance qualification",
    passed: observation.passed === true, causalPassed: observation.causalPassed === true, fixtureDisposalConfirmed: observation.fixtureDisposalConfirmed === true,
    stage: allowedStages.has(observation.stage) ? observation.stage : "scope" };
  if (allowedCompletionChecks.has(observation.completionCheck)) report.completionCheck = observation.completionCheck;
  if (/^[a-f0-9]{64}$/.test(observation.artifactSha256 ?? "")) report.artifactSha256 = observation.artifactSha256;
  for (const key of ["savedWhileHeld", "readWhileHeld", "visible", "barrierExpired", "originalAnswerSaved", "independentSaveSurvived", "sameOriginalBinding", "distinctFreshOwner", "duplicateSameOperation"])
    if (typeof observation[key] === "boolean") report[key] = observation[key];
  for (const key of ["saveMs", "readbackMs", "policyCalls", "queryCalls", "probeCalls", "policyProvenanceCount", "policyAuditCount", "toolAttempts", "duplicateAdditionalCalls", "patchStatus", "duplicateStatus"])
    if (Number.isSafeInteger(observation[key]) && observation[key] >= 0 && observation[key] <= 1000000) report[key] = observation[key];
  if (observation.switches && typeof observation.switches.remote === "boolean" && typeof observation.switches.local === "boolean")
    report.switches = { remote: observation.switches.remote, local: observation.switches.local };
  return report;
}
/** Preserve the original failure while independently reporting owned cleanup. */
export async function finishNativePolicyQualification({ barrier, fixture, observation, saveReport }, originalFailure) {
  barrier.release(); let cleanupFailure, reportFailure;
  try { await fixture?.close(); observation.fixtureDisposalConfirmed = fixture !== undefined; }
  catch (error) { cleanupFailure = error; observation.fixtureDisposalConfirmed = false; }
  observation.passed = observation.causalPassed === true && observation.fixtureDisposalConfirmed && !originalFailure;
  try { await saveReport(publicPolicyConcurrencyReport(observation)); } catch (error) { reportFailure = error; }
  if (originalFailure) throw originalFailure;
  if (cleanupFailure) throw cleanupFailure;
  if (reportFailure) throw reportFailure;
  assert(observation.passed, "Native held-policy concurrency was not accepted");
}

export async function qualifyNativePolicyConcurrency({ request, open, config, reportLabel }) {
  const reportName = policyConcurrencyReportName(reportLabel);
  assertNativePolicyConcurrencyScope(config); assert.match(process.version, /^v22\./);
  const artifactSha256 = createHash("sha256").update(await readFile(resolve(".functions/index.mjs"))).digest("hex");
  const observation = { artifactSha256, stage: "configuration", causalPassed: false, passed: false, fixtureDisposalConfirmed: false };
  const barrier = completionBarrier(); let fixture, originalFailure, initialOwner;
  try {
    initialOwner = await open(); let switches;
    try { switches = await initialOwner.readAuthoritative(state => ({ remote: state.settings.rbac?.enabled === true, local: state.settings.rbac?.localPolicyAgentEnabled === true })); }
    finally { await initialOwner.close(); }
    assert.equal(switches.local, true, "Configure local policy before qualification; this harness never changes policy switches"); observation.switches = switches;
    fixture = await startPolicyFixture(config, barrier);
    const expectHttp = async (path, method, payload, status = 200) => {
      const response = await request("api", path, method, payload);
      assert.equal(response.status, status, "Unexpected native policy-concurrency HTTP status; response body suppressed");
      assert(!response.body.includes(fixture.apiKey), "Literal fixture credential escaped HTTP"); return response.data.data;
    };
    observation.stage = "provider";
    const provider = await expectHttp("/api/providers", "POST", { name: "LOCAL literal held-policy concurrency fixture", type: "openai_compatible", baseUrl: fixture.baseUrl,
      apiKey: fixture.apiKey, model: fixtureModel, temperature: 0, egressPolicy: { approvedOrigin: new URL(fixture.baseUrl).origin, confirmed: true,
        interactiveDataClasses: ["restricted"], runtimeAnalysisDataClasses: [], runtimeAgentDataClasses: [] } }, 201);
    assert.equal((await expectHttp(`/api/providers/${provider.id}/test`, "POST", {})).ok, true);
    await expectHttp(`/api/providers/${provider.id}/activate`, "POST", {});
    const independent = await expectHttp("/api/workflows", "POST", { yaml: stringify(qaWorkflowBlueprint()) }, 201);
    const chat = await expectHttp("/api/chat/sessions", "POST", { title: "LOCAL literal policy concurrency", idempotencyKey: "native-held-policy-create-0001" }, 201);
    const payload = { content: policyConcurrencyRequest, model: fixtureModel, delivery: "async-chat", idempotencyKey: "native-held-policy-query-0001" };
    fixture.arm(); observation.stage = "admission";
    const admitted = await expectHttp(`/api/chat/sessions/${chat.id}/messages`, "POST", payload, 202);
    assert.equal(admitted.taskDispatch, "ENQUEUED"); assert.equal(admitted.operation.modelBinding?.providerId, provider.id);
    const binding = admitted.operation.modelBinding; observation.stage = "held_policy";
    const observing = new AbortController();
    try { await Promise.race([barrier.started, pause(20000, undefined, { signal: observing.signal }).then(() => { fixture.assertHealthy(); throw new Error("Original native local-policy request did not enter the hold"); })]); }
    finally { observing.abort(); }
    fixture.assertHealthy(); assert.equal(fixture.calls.filter(value => value === "policy").length, 1); assert.equal(fixture.calls.filter(value => value === "query").length, 0);
    const description = "Saved independently while the original local-policy preflight was held";
    observation.stage = "independent_save";
    const mutation = await observeHeldMutation(barrier, async () => {
      const response = await request("api", `/api/workflows/${independent.id}`, "PATCH", { description }); observation.patchStatus = response.status;
      assert.equal(response.status, 200, "Independent native PATCH must commit before policy release"); assert.equal(response.data.data.description, description); return true;
    }, async () => {
      observation.stage = "fresh_readback"; const repository = await open();
      try {
        assert.notEqual(repository, initialOwner, "Readback must open a distinct fresh persisted owner"); observation.distinctFreshOwner = true;
        return await repository.readAuthoritative(state => {
          const operation = state.chatOperations[admitted.operation.id];
          assert.equal(operation.actorId, "native_owner"); assert.deepEqual(operation.modelBinding, binding); assert.equal(operation.sessionId, chat.id);
          assert.equal(operation.status, "RUNNING"); assert.equal(operation.attempts.length, 0);
          const attempts = operation.modelAttemptsSecret?.filter(attempt => attempt.promptTemplateVersion === "prompt/local-policy/v2") ?? [];
          assert.equal(attempts.length, 1); assert.equal(attempts[0].status, "DISPATCH_INTENT");
          assert.deepEqual({ remote: state.settings.rbac?.enabled === true, local: state.settings.rbac?.localPolicyAgentEnabled === true }, switches);
          return state.workflows[independent.id]?.description === description;
        });
      } finally { await repository.close(); }
    });
    Object.assign(observation, { savedWhileHeld: mutation.savedWhileHeld, readWhileHeld: mutation.readWhileHeld, visible: mutation.visible,
      saveMs: mutation.saveMs, readbackMs: mutation.readbackMs, barrierExpired: barrier.observation().expired });
    assert(mutation.savedWhileHeld && mutation.readWhileHeld && mutation.visible && !barrier.observation().expired,
      "Committed PATCH and fresh-owner readback must complete before releasing the original policy");
    barrier.release(); observation.stage = "original_completion";
    let operation; const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const progress = await request("api", `/api/chat/operations/${admitted.operation.id}`, "GET");
      if (progress.status === 200) { operation = progress.data.data.operation; if (!["QUEUED", "RUNNING"].includes(operation.status)) break; }
      else { assert.equal(progress.status, 503); assert.equal(progress.data?.meta?.code, "FUNCTIONS_INVOCATION_UNCONFIRMED"); }
      await pause(500);
    }
    observation.completionCheck = "completion_status";
    fixture.assertHealthy(); assert.equal(operation?.status, "ANSWERED");
    const repository = await open(); let task;
    try { await repository.readAuthoritative(state => {
      const saved = state.chatOperations[admitted.operation.id], savedChat = state.chats[chat.id];
      observation.completionCheck = "operation_binding";
      assert.equal(saved.actorId, "native_owner"); assert.equal(saved.id, admitted.operation.id); assert.deepEqual(saved.modelBinding, binding);
      assert.equal(saved.status, "ANSWERED"); observation.completionCheck = "tool_attempts";
      assert.equal(saved.attempts.length, 0); observation.toolAttempts = saved.attempts.length;
      const answer = savedChat.messages.find(message => message.id === saved.assistantMessageId);
      assertPolicyConcurrencyAnswer(answer, binding, observation);
      observation.completionCheck = "policy_receipt";
      assert.equal(answer.artifacts.policyCheck.decision, "allow"); assert.equal(answer.artifacts.policyCheck.source, "local_model");
      observation.completionCheck = "provenance";
      const provenance = Object.values(state.invocationProvenance).filter(value => value.traceId === saved.traceId && value.promptTemplateVersion === "prompt/local-policy/v2");
      assert.equal(provenance.length, 1); assert.equal(provenance[0].status, "SUCCEEDED"); assert.equal(provenance[0].actor.id, saved.actorId);
      assert.equal(provenance[0].providerId, provider.id); assert.equal(provenance[0].model, fixtureModel);
      observation.completionCheck = "audit";
      const audits = state.auditLogs.filter(value => value.action === "optional_policy.evaluated" && value.traceId === saved.traceId);
      assert.equal(audits.length, 1); assert.equal(audits[0].after.decision, "allow");
      observation.completionCheck = "survival";
      assert.equal(state.workflows[independent.id].description, description);
      observation.completionCheck = "switches";
      assert.deepEqual({ remote: state.settings.rbac?.enabled === true, local: state.settings.rbac?.localPolicyAgentEnabled === true }, switches);
      observation.originalAnswerSaved = true; observation.independentSaveSurvived = true; observation.sameOriginalBinding = true;
      observation.policyProvenanceCount = provenance.length; observation.policyAuditCount = audits.length;
      observation.completionCheck = "task_delivery";
      task = { profile: "chat-task-delivery/v1", operationId: saved.id, taskId: assertChatTaskOutbox(saved).taskId };
    }); } finally { await repository.close(); }
    observation.stage = "duplicate";
    observation.completionCheck = "duplicate_operation";
    const beforeCalls = fixture.calls.length, duplicate = await expectHttp(`/api/chat/sessions/${chat.id}/messages`, "POST", payload, 202);
    assert.equal(duplicate.operation.id, admitted.operation.id); observation.duplicateSameOperation = true;
    observation.completionCheck = "duplicate_delivery";
    const delivery = await request("executeChatTask", "", "POST", { data: task }, false); observation.duplicateStatus = delivery.status;
    assert.equal(delivery.status, 204); observation.completionCheck = "duplicate_no_calls";
    observation.duplicateAdditionalCalls = fixture.calls.length - beforeCalls; assert.equal(observation.duplicateAdditionalCalls, 0);
    observation.policyCalls = fixture.calls.filter(value => value === "policy").length; observation.queryCalls = fixture.calls.filter(value => value === "query").length;
    observation.probeCalls = fixture.calls.filter(value => value === "probe").length;
    observation.completionCheck = "fixture_counts";
    assert.equal(observation.policyCalls, 1); assert.equal(observation.queryCalls, 1); fixture.assertHealthy();
    observation.causalPassed = true; observation.stage = "complete";
  } catch (error) { originalFailure = error; }
  finally {
    await finishNativePolicyQualification({ barrier, fixture, observation,
      saveReport: report => writeFile(resolve("../docs/evidence/2026-10-13", reportName), JSON.stringify(report, null, 2) + "\n", { flag: "wx" }) }, originalFailure);
  }
  return publicPolicyConcurrencyReport(observation);
}

// Operator-only acceptance: selected OpenRouter model, native Functions queues,
// emulator records and the exact Docker MockERP GET/process-local echo fixture.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { assertRealProviderQaConfiguration } from "./erpbridge-workspace-qa.mjs";
import { assertOperationTaskLedger } from "../src/runner/operation-task-outbox.js";
import { assertReadTaskOutbox } from "../src/runner/read-task-outbox.js";
import { canonicalJSONBytes } from "../src/core/canonical-json.js";
import { nativePolicyURL, nativeMatrixSynthesisPrompt } from "./native-functions-policy-qa.mjs";

const model = "deepseek/deepseek-v4.1-flash";
const echoValue = "native-operation-qa-ack";
const hash = value => createHash("sha256").update(canonicalJSONBytes(value)).digest("hex");
const safeId = value => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const safePolicy = receipt => ({
  decision: ["allow", "deny", "review", "unavailable"].includes(receipt?.decision) ? receipt.decision : null,
  source: ["skipped", "local_model", "erpbridge"].includes(receipt?.source) ? receipt.source : null,
  fallbackUsed: receipt?.fallbackUsed === true,
  failureCode: ["LOCAL_POLICY_CONFIG_INVALID", "LOCAL_POLICY_PROVIDER_FAILED", "LOCAL_POLICY_RESPONSE_INVALID", "POLICY_CHECK_CANCELLED"].includes(receipt?.failureCode)
    ? receipt.failureCode : null,
});

export function assertNativeRealPolicyMatrixScope(config, env = process.env, nodeVersion = process.version) {
  assert.match(nodeVersion, /^v22\./);
  assert.equal(env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:23671");
  assert.equal(env.GCLOUD_PROJECT, "demo-lcwe-records");
  assert(!env.GOOGLE_APPLICATION_CREDENTIALS);
  assertRealProviderQaConfiguration(env);
  assert.equal(config.APP_ENV, "development");
  assert.equal(config.LCWE_LOCAL_DOCKER_QA, "native-operation/v1");
  assert.equal(config.FIRESTORE_PROJECT_ID, "demo-lcwe-records");
  assert.equal(config.FIRESTORE_DATABASE_ID, "(default)");
  assert(/^test_[a-f0-9]{32}_native$/.test(config.FIRESTORE_WORKSPACE_ID));
  assert.equal(config.ERPBRIDGE_BASE_URL, "http://127.0.0.1:18080");
  assert.equal(config.GOVERNANCE_URL, nativePolicyURL);
  assert.equal(Buffer.from(config.STORAGE_ENCRYPTION_KEY, "base64").length, 32);
  assert(typeof config.GOVERNANCE_API_KEY === "string" && config.GOVERNANCE_API_KEY.length >= 32);
}

/** A model draft is accepted only when its entire executable surface matches the request. */
export function assertModelPolicyMatrixDraft(yaml, kind, fixtureId) {
  assert(typeof yaml === "string" && Buffer.byteLength(yaml) <= 16000);
  assert(["read", "operation"].includes(kind));
  const draft = parse(yaml);
  assert(draft && typeof draft === "object" && !Array.isArray(draft));
  assert(Object.keys(draft).every(key => ["name", "description", "trigger", "steps", "metadata"].includes(key)));
  assert.equal(draft.trigger?.type, "manual");
  assert.deepEqual(draft.trigger?.config ?? {}, {});
  assert(!draft.metadata || Object.keys(draft.metadata).every(key => ["tags", "domainTags", "unresolved_requirements"].includes(key)));
  if (draft.metadata && Object.hasOwn(draft.metadata, "unresolved_requirements"))
    assert.deepEqual(draft.metadata.unresolved_requirements, [], "The exact draft must have no unresolved requirements");
  assert(!draft.metadata?.controlFlow, "Only a plain ordered sequence is qualified");
  assert(Array.isArray(draft.steps));
  assert.equal(draft.steps.length, kind === "read" ? 1 : 2);
  assert(draft.steps.every(step => step && typeof step === "object" && typeof step.id === "string" && safeId(step.id)));
  assert(draft.steps.every(step => Object.keys(step).every(key => ["id", "action", "parameters", "description", "kind", "connection_id"].includes(key))));
  assert(draft.steps.every(step => !step.connection_id || step.connection_id === "erpbridge-default"));
  assert.equal(new Set(draft.steps.map(step => step.id)).size, draft.steps.length);
  assert.equal(draft.steps[0].action, "qa_list_departments");
  assert.deepEqual(draft.steps[0].parameters ?? {}, {});
  assert(!draft.steps[0].kind || draft.steps[0].kind === "tool");
  if (kind === "operation") {
    assert.equal(draft.steps[1].action, "qa_native_integration_echo");
    assert.deepEqual(draft.steps[1].parameters, { value: echoValue, fixtureId });
    assert(!draft.steps[1].kind || draft.steps[1].kind === "tool");
  }
  return { readNodeId: draft.steps[0].id, ...(kind === "operation" ? { echoNodeId: draft.steps[1].id } : {}) };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function reportWriter() {
  const directory = resolve("../docs/evidence/2026-10-13"); mkdirSync(directory, { recursive: true });
  const path = resolve(directory, `native-real-policy-matrix-${randomUUID()}.json`);
  return { path, write(value) {
    const descriptor = openSync(path, "wx", 0o600);
    try { const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n"); writeSync(descriptor, bytes); fsyncSync(descriptor); }
    finally { closeSync(descriptor); }
  } };
}

export async function qualifyNativeRealPolicyMatrix({ request, open, config, policy }) {
  const report = { profile: "native-real-policy-matrix/v1", success: false, startedAt: new Date().toISOString(),
    model, providerOrigin: "https://openrouter.ai", environment: "loopback-Functions-Firestore-Docker-MockERP",
    policyFixture: "LOCAL-native-operation-fixture/v1", remoteChecker: "not directly qualified; saved decision source is reported per draft",
    cases: [], checks: [], failure: null };
  const writer = reportWriter();
  let stage = "scope", caseName = null, lastOperationStatus = null, lastHttpCode = null;
  const check = (code, assertion) => {
    try { assertion(); report.checks.push({ case: caseName, stage, code, passed: true }); }
    catch (error) { report.checks.push({ case: caseName, stage, code, passed: false }); throw error; }
  };
  let lastMeta;
  const api = async (path, method = "GET", payload, expected = 200, actor = "native_owner") => {
    const result = await request("api", path, method, payload, actor);
    lastMeta = result.data?.meta;
    lastHttpCode = /^[A-Z][A-Z0-9_]{2,80}$/.test(lastMeta?.code ?? "") ? lastMeta.code : null;
    check("HTTP_STATUS", () => assert.equal(result.status, expected));
    check("HTTP_NO_PROVIDER_KEY", () => assert(!result.body.includes(process.env.GENERATION_API_KEY)));
    return result.data?.data;
  };
  const waitChat = async operationId => {
    let operation;
    for (const deadline = Date.now() + 180000; Date.now() < deadline; ) {
      operation = (await api(`/api/chat/operations/${operationId}`)).operation;
      lastOperationStatus = ["QUEUED", "RUNNING", "ANSWERED", "FAILED", "CANCELLED", "RECOVERY_REQUIRED"].includes(operation.status) ? operation.status : null;
      if (!["QUEUED", "RUNNING"].includes(operation.status)) break;
      await sleep(1000);
    }
    if (operation?.status !== "ANSWERED") {
      const repository = await open();
      try {
        report.terminalDiagnostic = await repository.readAuthoritative(state => {
          const original = state.chatOperations[operationId];
          const statuses = ["PREPARING", "DISPATCH_INTENT", "DONE", "FAILED", "UNKNOWN"];
          const reasons = ["CHAT_PHASE_OUTCOME_UNCONFIRMED", "CHAT_TASK_INTERRUPTED", "PROCESSING_STOPPED", "TOOL_OUTCOME_UNKNOWN",
            "POLICY_DENIED", "POLICY_REVIEW_REQUIRED", "LOCAL_POLICY_PROVIDER_FAILED", "LOCAL_POLICY_RESPONSE_INVALID"];
          const eventTypes = ["operation.started", "operation.stage", "model.dispatch_intent", "model.completed", "model.failed",
            "model.outcome_unknown", "model.interrupted", "tool.preparing", "tool.dispatch_intent", "tool.completed", "tool.failed",
            "tool.outcome_unknown", "answer.saved", "operation.stopped", "operation.recovery_required", "operation.cancel_requested"];
          return {
            operationId: safeId(operationId) ? operationId : null,
            reason: reasons.includes(original?.reason) ? original.reason : null,
            modelAttempts: (original?.modelAttemptsSecret ?? []).map(attempt => ({
              status: statuses.includes(attempt.status) ? attempt.status : null,
              policy: attempt.purpose === "POLICY_PREFLIGHT",
              hasSavedResult: typeof attempt.resultCiphertext === "string",
            })),
            toolAttempts: (original?.attempts ?? []).map(attempt => ({
              status: statuses.includes(attempt.status) ? attempt.status : null,
              reviewedFixture: ["qa_list_departments", "qa_native_integration_echo"].includes(attempt.toolName) ? attempt.toolName : null,
              hasSavedOutput: attempt.output !== undefined,
            })),
            savedAssistant: typeof original?.assistantMessageId === "string",
            events: (state.chatOperationEvents[operationId] ?? []).slice(-16).map(event =>
              eventTypes.includes(event.type) ? event.type : "other"),
          };
        });
      } finally { await repository.close(); }
    }
    check("CHAT_ANSWERED", () => assert.equal(operation?.status, "ANSWERED"));
    return operation;
  };
  const waitRun = async (executionId, target) => {
    let run;
    for (const deadline = Date.now() + 180000; Date.now() < deadline; ) {
      const response = await request("api", `/api/executions/${executionId}`, "GET");
      if (response.status === 200) {
        run = response.data.data;
        if (run.status === target) return run;
        check("RUN_PROGRESS", () => assert(["PENDING", "RUNNING"].includes(run.status)));
      } else check("WRITER_CONTENTION_ONLY", () => { assert.equal(response.status, 503); assert.equal(response.data?.meta?.code, "FUNCTIONS_INVOCATION_UNCONFIRMED"); });
      await sleep(2000);
    }
    check("RUN_TARGET", () => assert.equal(run?.status, target));
    return run;
  };
  const inspect = async executionId => {
    const repository = await open();
    try { return await repository.readAuthoritative(state => ({ run: structuredClone(state.executions[executionId]),
      events: structuredClone(state.executionEvents[executionId]), timeline: structuredClone(state.timelines[executionId]),
      readJob: structuredClone(state.readJobs[executionId]) })); }
    finally { await repository.close(); }
  };
  const optionalAuditCount = async () => {
    const repository = await open();
    try { return await repository.readAuthoritative(state => state.auditLogs.filter(event => event.action === "optional_policy.evaluated").length); }
    finally { await repository.close(); }
  };
  try {
    check("SCOPE", () => assertNativeRealPolicyMatrixScope(config));
    check("POLICY_FIXTURE", () => assert(policy && Array.isArray(policy.accepted) && typeof policy.setAvailable === "function"));
    const approvalSettings = await api("/api/settings/runtime-approval-policy");
    check("BASELINE_INDEPENDENT_APPROVAL", () => {
      assert.equal(approvalSettings.policy?.enabled, true);
      assert.equal(approvalSettings.policy?.separationOfDuties, true);
      assert(approvalSettings.policy?.approverRoleIds?.includes("native_review"));
      assert(approvalSettings.roles?.some(role => role.id === "native_review" && role.eligible === true));
    });
    stage = "provider";
    const provider = await api("/api/providers", "POST", { name: `REAL policy matrix ${randomUUID()}`, type: "openai_compatible",
      baseUrl: process.env.GENERATION_BASE_URL, apiKey: process.env.GENERATION_API_KEY, model, temperature: 0,
      egressPolicy: { approvedOrigin: "https://openrouter.ai", confirmed: true, interactiveDataClasses: ["restricted"], runtimeAnalysisDataClasses: [], runtimeAgentDataClasses: [] } }, 201);
    check("PROVIDER_ID", () => assert(safeId(provider.id)));
    const tested = await api(`/api/providers/${provider.id}/test`, "POST", {}); check("PROVIDER_TEST", () => assert.equal(tested.ok, true));
    await api(`/api/providers/${provider.id}/activate`, "POST", {});
    report.providerId = provider.id;
    for (const mode of ["off", "on"]) {
      caseName = mode; const row = { mode, switches: mode === "off" ? { remote: false, local: false } : { remote: true, local: true }, drafts: [] };
      report.cases.push(row); stage = "switches";
      await api("/api/settings", "PATCH", { rbac: { enabled: mode === "on", localPolicyAgentEnabled: mode === "on" } });
      const settings = await api("/api/settings");
      check("SWITCHES_SAVED", () => { assert.equal(settings.rbac.enabled, mode === "on"); assert.equal(settings.rbac.localPolicyAgentEnabled, mode === "on"); });
      stage = "query"; lastOperationStatus = null;
      const queryAuditBefore = await optionalAuditCount();
      const queryChat = await api("/api/chat/sessions", "POST", { title: `REAL ${mode} synthetic GET query`, idempotencyKey: randomUUID() }, 201);
      check("QUERY_CHAT_ID", () => assert(safeId(queryChat.id)));
      row.query = { chatId: queryChat.id, status: "started" };
      const queryAdmission = await api(`/api/chat/sessions/${queryChat.id}/messages`, "POST", {
        content: "List the synthetic Departments from ERPBridge.",
        delivery: "async-chat", idempotencyKey: randomUUID(), model }, 202);
      check("QUERY_DISPATCH", () => assert.equal(queryAdmission.taskDispatch, "ENQUEUED"));
      check("QUERY_MODEL_BINDING", () => assert.equal(queryAdmission.operation.modelBinding.model, model));
      check("QUERY_OPERATION_ID", () => assert(safeId(queryAdmission.operation.id)));
      row.query.operationId = queryAdmission.operation.id;
      const queryOperation = await waitChat(queryAdmission.operation.id);
      const querySaved = await api(`/api/chat/sessions/${queryChat.id}`);
      const queryMessage = querySaved.messages.find(value => value.id === queryOperation.assistantMessageId);
      check("QUERY_SAVED_MODEL", () => assert.equal(querySaved.selectedModel, model));
      check("QUERY_SAVED_MESSAGE", () => assert(queryMessage && queryMessage.operationId === queryOperation.id));
      check("QUERY_ANSWER_MODEL", () => { assert.equal(queryMessage.modelBinding?.model, model); assert.notEqual(queryMessage.modelBinding?.fallbackUsed, true); });
      row.query.clarification = queryMessage.artifacts?.clarification !== undefined;
      const queryReceipt = queryMessage.artifacts?.policyCheck;
      row.query.policy = safePolicy(queryReceipt);
      if (mode === "off") check("QUERY_OPTIONAL_POLICY_OFF", () => assert.equal(queryReceipt, undefined));
      else {
        check("QUERY_POLICY_ALLOW", () => assert.equal(queryReceipt?.decision, "allow"));
        check("QUERY_POLICY_ROUTE", () => { assert.equal(queryReceipt.source, "local_model"); assert.equal(queryReceipt.fallbackUsed, true); });
      }
      check("QUERY_EXACT_GET", () => {
        assert.equal(queryMessage.artifacts?.toolSteps?.length, 1);
        const tool = queryMessage.artifacts.toolSteps[0];
        assert.equal(tool.toolName, "qa_list_departments"); assert.equal(tool.status, "SUCCEEDED");
        assert.deepEqual(tool.arguments ?? {}, {});
        assert.equal(tool.result.structuredContent.data.length, 8);
        assert.equal(queryMessage.artifacts.emailDraft, undefined);
        assert.equal(queryMessage.artifacts.workflowId, undefined);
      });
      const queryAuditAfter = await optionalAuditCount();
      check("QUERY_OPTIONAL_POLICY_AUDIT_ROUTE", () => mode === "off"
        ? assert.equal(queryAuditAfter - queryAuditBefore, 0)
        : assert(queryAuditAfter - queryAuditBefore >= 1));
      row.query.status = "ANSWERED_WITH_EIGHT_GET_ROWS"; row.query.rows = 8;
      row.query.optionalPolicyAuditDelta = queryAuditAfter - queryAuditBefore;
      for (const kind of ["read", "operation"]) {
        const fixtureId = randomUUID(), draft = { kind, fixtureId, status: "started" }; row.drafts.push(draft);
        const auditBefore = await optionalAuditCount(), governanceBefore = policy.accepted.length;
        stage = "generate"; lastOperationStatus = null;
        const chat = await api("/api/chat/sessions", "POST", { title: `REAL ${mode} ${kind} synthetic matrix`, idempotencyKey: randomUUID() }, 201);
        check("CHAT_ID", () => assert(safeId(chat.id))); draft.chatId = chat.id;
        const prompt = nativeMatrixSynthesisPrompt(kind, fixtureId);
        const command = { content: prompt, delivery: "async-chat", idempotencyKey: randomUUID(), model };
        const admitted = await api(`/api/chat/sessions/${chat.id}/messages`, "POST", command, 202);
        check("CHAT_DISPATCH", () => assert.equal(admitted.taskDispatch, "ENQUEUED"));
        check("MODEL_BINDING", () => assert.equal(admitted.operation.modelBinding.model, model));
        check("CHAT_OPERATION_ID", () => assert(safeId(admitted.operation.id)));
        draft.chatOperationId = admitted.operation.id;
        const operation = await waitChat(admitted.operation.id);
        const saved = await api(`/api/chat/sessions/${chat.id}`);
        check("SELECTED_MODEL", () => assert.equal(saved.selectedModel, model));
        const message = saved.messages.find(value => value.id === operation.assistantMessageId);
        check("SAVED_MESSAGE", () => assert(message && message.operationId === operation.id));
        check("ANSWER_MODEL", () => { assert.equal(message.modelBinding?.model, model); assert.notEqual(message.modelBinding?.fallbackUsed, true); });
        draft.clarification = message.artifacts?.clarification !== undefined || message.artifacts?.intent === "CLARIFICATION";
        const receipt = message.artifacts?.policyCheck;
        draft.policy = safePolicy(receipt);
        if (mode === "off") check("OPTIONAL_POLICY_OFF", () => assert.equal(receipt, undefined));
        else {
          check("POLICY_ALLOW", () => assert.equal(receipt?.decision, "allow"));
          check("POLICY_ROUTE", () => { assert.equal(receipt.source, "local_model"); assert.equal(receipt.fallbackUsed, true); });
        }
        check("MODEL_DRAFT_SAVED", () => assert(safeId(message.artifacts?.workflowId) && message.artifacts?.intent === "WORKFLOW"));
        const workflowId = message.artifacts.workflowId; draft.workflowId = workflowId;
        const source = await api(`/api/workflows/${workflowId}/yaml`);
        let nodes;
        check("EXACT_MODEL_DRAFT", () => { nodes = assertModelPolicyMatrixDraft(source.yaml, kind, fixtureId); assert(nodes.readNodeId); });
        draft.sourceSha256 = hash(source.yaml); draft.version = source.version;
        const readiness = await api(`/api/workflows/${workflowId}/readiness`);
        check("READINESS", () => assert.equal(readiness.validation.passed, true));
        check("REVISION_MATCH", () => { assert.equal(readiness.version, source.version); assert.equal(readiness.contentHash, source.contentHash); });
        stage = "publish";
        await api(`/api/workflows/${workflowId}/publish`, "POST", { baseVersion: readiness.version, baseHash: readiness.contentHash });
        const published = await api(`/api/workflows/${workflowId}/yaml`);
        check("PUBLISHED_EXACT_SOURCE", () => { assert.equal(published.yaml, source.yaml); assert.equal(published.publishedVersion, source.version); });
        check("MANDATORY_GOVERNANCE", () => {
          const accepted = policy.accepted.slice(governanceBefore);
          for (const intent of [prompt, "PublishWorkflow"])
            assert(accepted.some(value => value.intent === intent && value.actions.includes("qa_list_departments") &&
              (intent !== prompt || value.kind === "SynthesisWorkflow") &&
              (kind === "read" ? !value.actions.includes("qa_native_integration_echo") : value.actions.includes("qa_native_integration_echo"))));
        });
        draft.publishedVersion = published.publishedVersion;
        stage = "run";
        const runCommand = { mode: kind === "read" ? "async-read" : "async-operation", idempotencyKey: randomUUID(), input: {} };
        const run = await api(`/api/workflows/${workflowId}/run`, "POST", runCommand, 202);
        check("EXECUTION_ID", () => assert(safeId(run.id)));
        draft.executionId = run.id;
        check("RUN_DISPATCH", () => assert.equal(lastMeta?.taskDispatch, "ENQUEUED"));
        if (kind === "read") {
          const done = await waitRun(run.id, "DONE");
          check("EIGHT_READ_ROWS", () => assert.equal(done.stepOutputs[nodes.readNodeId].structuredContent.data.length, 8));
          const before = await inspect(run.id), outbox = assertReadTaskOutbox(before.readJob);
          check("READ_OUTBOX", () => { assert.equal(before.readJob.state, "FINISHED"); assert.equal(outbox.state, "ENQUEUED"); });
          const duplicate = await request("executeReadTask", "", "POST", { data: { profile: "read-task-delivery/v1", executionId: run.id, taskId: outbox.taskId } }, false);
          check("READ_DUPLICATE_DELIVERY", () => assert.equal(duplicate.status, 204));
          const repeated = await api(`/api/workflows/${workflowId}/run`, "POST", runCommand, 202);
          check("READ_SAME_KEY", () => assert.equal(repeated.id, run.id));
          const after = await inspect(run.id); check("READ_JOURNAL_UNCHANGED", () => assert.deepEqual(after, before));
          draft.status = "DONE"; draft.rows = 8; draft.journalSha256 = hash(before.events);
        } else {
          const pending = await waitRun(run.id, "AWAITING_APPROVAL");
          check("EIGHT_ROWS_BEFORE_APPROVAL", () => assert.equal(pending.stepOutputs[nodes.readNodeId].structuredContent.data.length, 8));
          check("NO_ECHO_BEFORE_APPROVAL", () => assert.equal(pending.stepOutputs[nodes.echoNodeId], undefined));
          const view = await api(`/api/executions/${run.id}?view=approval`, "GET", undefined, 200, "native_reviewer");
          const approval = view.runtimeApproval;
          check("APPROVAL_RECORD", () => assert(safeId(approval?.id) && Number.isInteger(approval.version) && typeof approval.reviewHash === "string"));
          const approvalCommand = { approvalId: approval.id, baseVersion: approval.version, reviewHash: approval.reviewHash, decisionKey: randomUUID() };
          await api(`/api/executions/${run.id}/approve`, "POST", approvalCommand, 403);
          const before = await inspect(run.id), initialLedger = assertOperationTaskLedger(before.run);
          check("APPROVAL_WAIT_LEDGER", () => assert.equal(initialLedger.generations[0].completion.milestone, "AWAITING_APPROVAL"));
          const granted = await api(`/api/executions/${run.id}/approve`, "POST", approvalCommand, 200, "native_reviewer");
          check("APPROVAL_DISPATCH", () => assert.equal(granted.taskDispatch, "ENQUEUED"));
          const done = await waitRun(run.id, "DONE");
          check("EIGHT_ROWS_AFTER_APPROVAL", () => assert.equal(done.stepOutputs[nodes.readNodeId].structuredContent.data.length, 8));
          check("ECHO_EXACT_ACK", () => { assert.equal(done.stepOutputs[nodes.echoNodeId].structuredContent.value, echoValue); assert.equal(done.stepOutputs[nodes.echoNodeId].structuredContent.fixtureId, fixtureId); });
          const committed = await inspect(run.id), ledger = assertOperationTaskLedger(committed.run);
          check("APPROVAL_CONSUMED", () => { assert.equal(ledger.generations.length, 2); assert.equal(committed.run.runtimeApprovalSecret.records[approval.id].state, "CONSUMED"); });
          for (const generation of ledger.generations) {
            const duplicate = await request("executeOperationTask", "", "POST", { data: { profile: "operation-task-delivery/v1", executionId: run.id, taskId: generation.taskId } }, false);
            check("OPERATION_DUPLICATE_DELIVERY", () => assert.equal(duplicate.status, 204));
          }
          const repeated = await api(`/api/workflows/${workflowId}/run`, "POST", runCommand, 202);
          check("OPERATION_SAME_KEY", () => assert.equal(repeated.id, run.id));
          const replay = await api(`/api/executions/${run.id}/approve`, "POST", approvalCommand, 200, "native_reviewer");
          check("APPROVAL_SAME_KEY", () => assert.equal(replay.replayed, true));
          const after = await inspect(run.id); check("OPERATION_JOURNAL_UNCHANGED", () => assert.deepEqual(after, committed));
          draft.status = "DONE"; draft.rows = 8; draft.echoAcknowledged = true; draft.journalSha256 = hash(committed.events);
        }
        const auditAfter = await optionalAuditCount();
        check("OPTIONAL_POLICY_AUDIT_ROUTE", () => mode === "off"
          ? assert.equal(auditAfter - auditBefore, 0)
          : assert(auditAfter - auditBefore >= 1));
        draft.optionalPolicyAuditDelta = auditAfter - auditBefore;
      }
    }
    report.success = true;
  } catch (error) {
    // No arbitrary error text, response body, model output, prompt or credential
    // is copied into the public report. The original failure remains private.
    const failed = report.checks.findLast(value => value.passed === false);
    const row = report.cases.find(value => value.mode === caseName);
    const draft = row?.drafts.at(-1);
    const policyEvidence = stage === "query" ? row?.query?.policy : draft?.policy;
    const operationId = stage === "query" ? row?.query?.operationId : draft?.chatOperationId;
    const allowedPolicyCode = ["LOCAL_POLICY_CONFIG_INVALID", "LOCAL_POLICY_PROVIDER_FAILED", "LOCAL_POLICY_RESPONSE_INVALID", "POLICY_CHECK_CANCELLED"];
    report.failure = { case: caseName, stage, check: failed?.code ?? null,
      code: allowedPolicyCode.includes(policyEvidence?.failureCode) ? policyEvidence.failureCode :
        policyEvidence?.decision === "review" ? "POLICY_REVIEW" : policyEvidence?.decision === "deny" ? "POLICY_DENIAL" :
          (stage === "query" ? row?.query?.clarification : draft?.clarification) ? "MODEL_CLARIFICATION" :
          lastHttpCode ?? (error?.name === "AssertionError" ? "CONTRACT_ASSERTION_FAILED" : "CAMPAIGN_STEP_FAILED"),
      chatOperationStatus: lastOperationStatus, operationId: safeId(operationId) ? operationId : null };
  } finally {
    report.finishedAt = new Date().toISOString(); writer.write(report);
  }
  return { success: report.success, reportPath: writer.path, failure: report.failure };
}

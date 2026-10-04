// Operator-requested real inference, bounded to the existing loopback demo.
// Credentials enter through the process environment and never enter reports.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import { nativeMatrixSynthesisPrompt } from "./native-functions-policy-qa.mjs";

const model = "deepseek/deepseek-v4.1-flash", base = "http://127.0.0.1:23675/demo-lcwe-records/asia-south1/api/api";
let stage = "scope";
try {
  assert(["--run", "--decision-only"].includes(process.argv[2]) && process.argv.length === 3);
  const { profile, config } = JSON.parse(await readFile(".functions/qa-session.json", "utf8"));
  assert.equal(profile, "lcwe-native-functions-qa/v1"); assert.equal(config.FIRESTORE_PROJECT_ID, "demo-lcwe-records");
  assert.equal(config.ERPBRIDGE_BASE_URL, "http://127.0.0.1:18080"); assert.match(config.FIRESTORE_WORKSPACE_ID, /^test_[a-f0-9]{32}_native$/);
  if (process.argv[2] === "--run") assert(process.env.OPENROUTER_API_KEY?.startsWith("sk-or-"));
  let token;
  const request = async (path, method = "GET", payload, expected = 200) => {
    const response = await fetch(`${base}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(90000),
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const body = await response.json();
    if (response.status !== expected) console.error(JSON.stringify({ checkpoint: "HTTP_refused", stage, status: response.status, code: body.meta?.code, rules: body.meta?.failed_rules }));
    assert.equal(response.status, expected, `HTTP ${response.status} at ${stage}; private response suppressed`);
    assert(!process.env.OPENROUTER_API_KEY || !JSON.stringify(body).includes(process.env.OPENROUTER_API_KEY), "Credential escaped response");
    return body.data;
  };
  token = (await request("/auth/login", "POST", { email: "native@example.test", password: "Synthetic-local-only-2026!" })).accessToken;
  const suffix = randomUUID();
  if (process.argv[2] === "--run") {
  stage = "provider";
  const provider = await request("/providers", "POST", { name: `LOCAL supervisor demo DeepSeek ${suffix}`, type: "openai_compatible", baseUrl: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY, model, temperature: 0, egressPolicy: { approvedOrigin: "https://openrouter.ai", confirmed: true,
      interactiveDataClasses: ["restricted"], runtimeAnalysisDataClasses: ["internal"], runtimeAgentDataClasses: ["internal"] } }, 201);
  const tested = await request(`/providers/${provider.id}/test`, "POST", {}); assert.equal(tested.ok, true);
  await request(`/providers/${provider.id}/activate`, "POST", {});
  console.log(JSON.stringify({ checkpoint: "provider_tested_and_selected", model, providerId: provider.id }));
  stage = "chat";
  const chat = await request("/chat/sessions", "POST", { title: "Supervisor demo · Pi and DeepSeek", idempotencyKey: `mini-chat-${suffix}` }, 201);
  const send = async (content, nodeContext) => {
    const admitted = await request(`/chat/sessions/${chat.id}/messages`, "POST", { content, delivery: "async-chat", model,
      idempotencyKey: `mini-turn-${randomUUID()}`, ...(nodeContext ? { nodeContext } : {}) }, 202);
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const progress = await request(`/chat/operations/${admitted.operation.id}`);
      if (!["QUEUED", "RUNNING"].includes(progress.operation.status)) {
        assert.equal(progress.operation.status, "ANSWERED", `Chat status ${progress.operation.status}`);
        const saved = await request(`/chat/sessions/${chat.id}`);
        return saved.messages.find(message => message.id === progress.operation.assistantMessageId);
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw new Error("Chat did not reach its terminal checkpoint");
  };
  stage = "Pi_ERP_query";
  const query = await send("List the synthetic Departments from ERPBridge. Do not create or change ERP records or send email.");
  const rows = query.artifacts?.toolSteps?.find(step => step.status === "SUCCEEDED")?.result?.structuredContent?.data;
  assert.equal(rows?.length, 8);
  console.log(JSON.stringify({ checkpoint: "Pi_real_model_ERP_query", model, chatId: chat.id, rows: rows.length }));
  stage = "generate";
  const generated = await send(nativeMatrixSynthesisPrompt("read")), workflowId = generated.artifacts?.workflowId;
  assert(workflowId, "Model did not save a workflow");
  let ready = await request(`/workflows/${workflowId}/readiness`);
  const source = await request(`/workflows/${workflowId}/yaml`), blueprint = parse(source.yaml), nodeId = blueprint.steps[0].id;
  assert.equal(blueprint.steps.length, 1); assert.equal(blueprint.steps[0].action, "qa_list_departments");
  stage = "node_proposal";
  const edit = await send('Change only this node description to "Review departments". Preserve the action, parameters, connection and all other fields.', { workflowId, nodeId, baseVersion: ready.version, baseHash: ready.contentHash });
  const proposal = edit.artifacts?.proposal; assert.equal(proposal?.status, "PROPOSED");
  assert.equal((await request(`/workflows/${workflowId}/yaml`)).yaml, source.yaml);
  await request(`/workflows/${workflowId}/commands`, "POST", { baseVersion: ready.version, baseHash: ready.contentHash, proposalId: proposal.id, command: proposal.command });
  ready = await request(`/workflows/${workflowId}/readiness`);
  await request(`/workflows/${workflowId}/publish`, "POST", { baseVersion: ready.version, baseHash: ready.contentHash });
  stage = "run";
  const command = { mode: "async-read", idempotencyKey: `mini-run-${suffix}`, input: {} };
  const run = await request(`/workflows/${workflowId}/run`, "POST", command, 202);
  const waitRun = async id => {
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const saved = await request(`/executions/${id}`);
      if (!["PENDING", "RUNNING"].includes(saved.status)) { assert.equal(saved.status, "DONE"); return saved; }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw new Error("Run did not complete");
  };
  const done = await waitRun(run.id); assert.equal(done.stepOutputs[nodeId].structuredContent.data.length, 8);
  assert.equal((await request(`/workflows/${workflowId}/run`, "POST", command, 202)).id, run.id);
  console.log(JSON.stringify({ checkpoint: "generated_edited_published_run", model, chatId: chat.id, workflowId, executionId: run.id, draftVersion: ready.version, rows: 8 }));
  }
  stage = "decision_demo";
  const step = id => ({ id, action: "qa_list_departments", description: ({ yes: "Review approved departments", no: "Review departments needing attention", after: "Prepare department summary" })[id], parameters: {} });
  const action = nodeId => ({ kind: "action", nodeId }), sequence = (...nodes) => ({ kind: "sequence", nodes });
  const decision = await request("/workflows", "POST", { yaml: stringify({ name: "Department review · decision demo", description: "Synthetic ERP reads showing Yes / No paths and the shared next step.", trigger: { type: "manual" },
    steps: [step("yes")], metadata: { controlFlow: { schemaVersion: "read-control-flow/v2", root: sequence({ kind: "if", id: "review_ready", predicate: { kind: "literal", value: true }, then: sequence(action("yes")), else: sequence({ kind: "return", id: "no_review_needed", output: { schema: { type: "string" }, value: { kind: "literal", value: "No review requested" } } }) }, { kind: "return", id: "review_complete", output: { schema: { type: "string" }, value: { kind: "literal", value: "Department review complete" } } }) } } }) }, 201);
  const decisionReady = await request(`/workflows/${decision.id}/readiness`); assert.equal(decisionReady.validation.passed, true);
  await request(`/workflows/${decision.id}/publish`, "POST", { baseVersion: decisionReady.version, baseHash: decisionReady.contentHash });
  const decisionRun = await request(`/workflows/${decision.id}/run`, "POST", { mode: "async-read", idempotencyKey: `mini-decision-${suffix}`, input: {} }, 202);
  let decisionDone;
  for (const deadline = Date.now() + 180000; Date.now() < deadline;) {
    decisionDone = await request(`/executions/${decisionRun.id}`);
    if (!["PENDING", "RUNNING"].includes(decisionDone.status)) break;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  assert.equal(decisionDone?.status, "DONE"); assert.equal(decisionDone.readProgress.decisions.review_ready.selected, "then");
  assert.equal(decisionDone.stepOutputs.no, undefined); assert.equal(decisionDone.stepOutputs.yes.structuredContent.data.length, 8);
  console.log(JSON.stringify({ checkpoint: "decision_demo_done", workflowId: decision.id, executionId: decisionRun.id, selected: "Yes", skipped: "No", rows: 8 }));
  console.log(process.argv[2] === "--run" ? "PASS: real DeepSeek/Pi query, generation, reviewed node edit, publication, original-key run and a separate saved decision demo; local Functions/Firestore and Docker MockERP only." : "PASS: saved decision demo completed; real-model checks were not replayed.");
} catch { console.error(JSON.stringify({ ok: false, stage, message: "Mini-canvas qualification stopped; private request and response suppressed. No automatic replay." })); process.exitCode = 1; }

// Explicit operator campaign: real owner-selected inference with ONLY the
// existing loopback Docker MockERP read. No production data/effect/deployment.
import assert from "node:assert/strict";
import { createQaWorkspace } from "./erpbridge-workspace-qa.mjs";
import { parse, stringify } from "yaml";
import { workflowContentHash } from "../src/parser/workflow.js";

assert.equal(process.argv[2], "--synthetic-docker-only");
process.env.LCWE_REAL_MODEL_QA = "synthetic-docker-only";
const workspace = await createQaWorkspace({ realProvider: true });
try {
  const login = await workspace.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "qa@example.test", password: "Local-QA-only-2026!" } });
  assert.equal(login.statusCode, 200);
  const headers = { authorization: `Bearer ${login.json().data.accessToken}` };
  const request = async (method, url, payload, status = 200) => {
    const response = await workspace.app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload }) });
    assert(!response.body.includes(process.env.GENERATION_API_KEY), "Provider secret escaped the public response");
    assert.equal(response.statusCode, status, `Unexpected status for ${method} ${url}: ${response.json().meta?.code ?? "details suppressed"}`);
    return response.json().data;
  };
  const provider = await request("POST", "/api/providers", { name: "REAL DeepSeek · synthetic Docker-only acceptance", type: "openai_compatible",
    baseUrl: process.env.GENERATION_BASE_URL, apiKey: process.env.GENERATION_API_KEY, model: process.env.GENERATION_MODEL_PRIMARY, temperature: 0,
    egressPolicy: { approvedOrigin: "https://openrouter.ai", confirmed: true, interactiveDataClasses: ["restricted"], runtimeAnalysisDataClasses: [], runtimeAgentDataClasses: [] } }, 201);
  await request("POST", `/api/providers/${provider.id}/activate`, {});
  const chat = await request("POST", "/api/chat/sessions", { title: "REAL DeepSeek, synthetic Department sample", idempotencyKey: "live-prototype-create-0001" }, 201);
  const send = async (content, idempotencyKey, nodeContext) => {
    const admitted = await request("POST", `/api/chat/sessions/${chat.id}/messages`, { content, idempotencyKey, delivery: "async-chat",
      model: process.env.GENERATION_MODEL_PRIMARY, ...(nodeContext ? { nodeContext } : {}) }, 202);
    let terminal; const deadline = Date.now() + 90000;
    do {
      terminal = await request("GET", `/api/chat/operations/${admitted.operation.id}`);
      if (!["QUEUED", "RUNNING"].includes(terminal.operation.status)) break;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    assert.equal(terminal.operation.status, "ANSWERED", `Live chat stopped: ${terminal.operation.status}`);
    const saved = await request("GET", `/api/chat/sessions/${chat.id}`);
    assert.equal(saved.selectedModel, process.env.GENERATION_MODEL_PRIMARY);
    const message = saved.messages.find(value => value.id === terminal.operation.assistantMessageId); assert(message);
    assert(!message.artifacts?.blocked, `Live chat blocked: ${message.artifacts?.code ?? "details suppressed"}`);
    return message;
  };
  const answer = await send("List the synthetic Departments from ERPBridge.", "live-prototype-query-0001");
  assert.equal(answer.artifacts.toolSteps[0].status, "SUCCEEDED");
  assert.equal(answer.artifacts.toolSteps[0].result.structuredContent.data.length, 8);
  console.log("PASS: real selected DeepSeek tool chat returned eight actual Docker MockERP rows through governed MCP");
  const generated = await send("Create a manual read-only workflow to list the available synthetic Departments using the admitted ERPBridge read tool. Use one tool node, no analysis or agent node, no schedule, and no write.", "live-prototype-generation-0001");
  const workflowId = generated.artifacts.workflowId;
  if (!workflowId) console.error("Generation diagnostics", { intent: generated.artifacts?.intent, answer: generated.text?.slice(0, 2000), validation: generated.artifacts?.validation, provider: workspace.providerDiagnostics });
  assert(workflowId, "Real generation did not acknowledge a saved draft");
  const source = await request("GET", `/api/workflows/${workflowId}/yaml`);
  assert.equal(source.publishedVersion, 0);
  const blueprint = parse(source.yaml); assert.equal(blueprint.steps.length, 1);
  const node = blueprint.steps[0]; assert.equal(node.action, "qa_list_departments");
  const ready = await request("GET", `/api/workflows/${workflowId}/readiness`);
  if (!ready.validation.passed) console.error("Saved candidate readiness diagnostics", { validation: ready.validation, provider: workspace.providerDiagnostics });
  assert.equal(ready.validation.passed, true, "Saved real-model draft did not pass readiness validation");
  const proposed = await send('Change only this node\'s description to exactly "Reviewed synthetic Department lookup" (without a trailing full stop). Preserve the action, parameters, connection and all other workflow fields.', "live-prototype-edit-0001",
    { workflowId, nodeId: node.id, baseVersion: ready.version, baseHash: ready.contentHash });
  const proposal = proposed.artifacts.proposal; assert.equal(proposal.status, "PROPOSED");
  assert.equal((await request("GET", `/api/workflows/${workflowId}/yaml`)).yaml, source.yaml);
  await request("POST", `/api/workflows/${workflowId}/commands`, { baseVersion: ready.version, baseHash: ready.contentHash, proposalId: proposal.id, command: proposal.command });
  const edited = await request("GET", `/api/workflows/${workflowId}/yaml`); assert.equal(edited.version, 2); assert.equal(edited.publishedVersion, 0);
  const after = parse(edited.yaml); assert.equal(after.steps[0].description, "Reviewed synthetic Department lookup");
  const expected = structuredClone(blueprint); expected.steps[0].description = after.steps[0].description; assert.deepEqual(after, expected);
  console.log("PASS: real generation saved draft; real node proposal stayed unapplied until review; Apply saved v2 and preserved unrelated source");
  const invalid = structuredClone(after); invalid.steps[0].action = "unknown_unadmitted_tool";
  const workflowsBefore = Object.keys((await workspace.repository.snapshot()).workflows).length;
  await request("POST", "/api/workflows", { yaml: stringify(invalid) }, 422);
  assert.equal(Object.keys((await workspace.repository.snapshot()).workflows).length, workflowsBefore, "An unknown tool bypassed draft validation");
  await request("POST", `/api/workflows/${workflowId}/publish`, { baseVersion: edited.version, baseHash: workflowContentHash(edited.yaml) });
  const run = await request("POST", `/api/workflows/${workflowId}/run`, { mode: "async-read", idempotencyKey: "live-prototype-run-0001", input: {} }, 202);
  let terminal; const deadline = Date.now() + 30000;
  do { terminal = await request("GET", `/api/executions/${run.id}`); if (!["PENDING", "RUNNING"].includes(terminal.status)) break; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline);
  assert.equal(terminal.status, "DONE"); assert.equal(terminal.stepOutputs[node.id].structuredContent.data.length, 8);
  const state = await workspace.repository.snapshot(), admission = Object.values(state.capabilityAdmissions).find(value => value.state === "AVAILABLE"); assert(admission);
  await request("POST", `/api/registry/capabilities/${admission.capabilityId}/disable`, { revisionId: admission.revisionId, baseVersion: admission.version, note: "Synthetic acceptance: verify fresh policy denial" });
  const countBefore = Object.keys((await workspace.repository.snapshot()).executions).length;
  const revoked = await workspace.app.inject({ method: "POST", url: `/api/workflows/${workflowId}/run`, headers, payload: { mode: "async-read", idempotencyKey: "live-prototype-revoked-0001", input: {} } });
  assert(revoked.statusCode >= 400, "Disabled capability still admitted a new execution");
  assert.equal(Object.keys((await workspace.repository.snapshot()).executions).length, countBefore);
  const reload = await request("GET", `/api/workflows/${workflowId}/yaml`); assert.equal(reload.yaml, edited.yaml);
  assert.deepEqual((await request("GET", `/api/executions/${run.id}`)).stepOutputs, terminal.stepOutputs);
  console.log("PASS: validated published v2 run DONE with eight saved node rows; unknown tool draft and revoked new-run admission denied; saved source/results reopen unchanged");
  console.log("LIMIT: actual DeepSeek/OpenRouter and Docker MockERP through normal API; memory-only isolated workspace, not rendered browser, Firestore restart durability, unknown-tool import, email, schedules or deployment");
} catch (error) { console.error(error instanceof Error ? error.message : "Live prototype qualification failed; details suppressed"); process.exitCode = 1; }
finally { await workspace.close(); }

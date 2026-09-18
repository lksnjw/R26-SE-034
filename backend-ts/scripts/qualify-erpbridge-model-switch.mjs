// Actual disposable Docker MCP + LOCAL model fixtures. No external provider,
// business records, delivery, production policy or ERPBridge source is changed.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { createQaWorkspace, qaModelReadBlueprint } from "./erpbridge-workspace-qa.mjs";

export async function main(args) {
  if (args.length !== 1 || args[0] !== "--run-synthetic-model-switch")
    throw new Error("Use the explicit disposable synthetic model-switch flag");
  const workspace = await createQaWorkspace({ modelReadFixture: true });
  try {
    const login = await workspace.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "qa@example.test", password: "Local-QA-only-2026!" } });
    assert.equal(login.statusCode, 200);
    const headers = { authorization: `Bearer ${login.json().data.accessToken}` };
    const request = async (method, url, payload, status = 200) => {
      const response = await workspace.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
      assert.equal(response.statusCode, status, `Synthetic ${method} ${url}: unexpected status`);
      return response.json().data;
    };
    const runtime = workspace.services.providerRuntime, original = runtime.configuration;
    const modelA = original.model, modelB = "local-alternate-fixture";
    runtime.activate({ ...original, additionalModels: [modelB] });
    assert.deepEqual((await request("GET", "/api/chat/models")).models, [modelA, modelB]);
    const waitFor = async (url, active) => {
      const deadline = Date.now() + 15000;
      do {
        const response = await request("GET", url), value = response.operation ?? response;
        if (!active.includes(value.status)) return value;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      throw new Error("Synthetic model-switch evidence did not settle within its budget");
    };
    const send = async (key, model, nodeContext) => {
      const before = await workspace.repository.snapshot();
      const response = await request("POST", "/api/chat/sessions/qa_chat/messages", {
        content: nodeContext ? "Describe this synthetic Department read more clearly." : "List the synthetic Departments from ERPBridge.",
        model, delivery: "async-chat", idempotencyKey: key, ...(nodeContext ? { nodeContext } : {}),
      }, 202);
      assert.equal(response.operation.modelBinding.model, model);
      const operation = await waitFor(`/api/chat/operations/${response.operation.id}`, ["QUEUED", "RUNNING"]);
      assert.equal(operation.status, "ANSWERED");
      const state = await workspace.repository.snapshot();
      const message = state.chats.qa_chat.messages.find(value => value.id === operation.assistantMessageId);
      assert.equal((message.modelBinding ?? message.artifacts?.proposal?.modelBinding)?.model, model);
      const invocations = Object.values(state.invocationProvenance).filter(value => !before.invocationProvenance[value.id]);
      assert.ok(invocations.length > 0); assert.ok(invocations.every(value => value.model === model));
      assert.equal(runtime.binding.model, modelA, "Chat selection changed the administration/runtime default");
      return { state, message, invocations };
    };
    for (const [index, model] of [modelA, modelB, modelA].entries()) {
      const result = await send(`synthetic-model-switch-${index}-0001`, model);
      const rows = result.message.artifacts.toolSteps[0]?.result?.structuredContent?.data;
      assert.ok(Array.isArray(rows) && rows.length > 0, "No acknowledged actual Docker rows");
      assert.equal(result.state.chats.qa_chat.selectedModel, model);
      assert.equal((await request("GET", "/api/chat/sessions/qa_chat")).selectedModel, model);
      console.log(`LOCAL Docker chat ${index + 1}: ${model}, ${rows.length} acknowledged synthetic rows; default unchanged.`);
    }
    const readiness = await request("GET", "/api/workflows/qa_departments/readiness");
    const originalYaml = (await workspace.repository.snapshot()).workflows.qa_departments.yaml;
    const proposal = await send("synthetic-model-switch-node-0001", modelB, {
      workflowId: "qa_departments", nodeId: "departments", baseVersion: readiness.version, baseHash: readiness.contentHash,
    });
    assert.equal(proposal.message.artifacts.proposal.modelBinding.model, modelB);
    assert.equal(proposal.state.workflows.qa_departments.yaml, originalYaml);
    assert.equal(Object.keys(proposal.state.executions).length, 0);
    assert.equal(proposal.message.artifacts.proposal.status, "PROPOSED");
    console.log("LOCAL Docker selected-node model B: proposal only, original draft unchanged, no execution.");

    const draft = await request("POST", "/api/workflows", { yaml: stringify(qaModelReadBlueprint("analysis")) }, 201);
    await request("POST", `/api/workflows/${draft.id}/publish`, {});
    const beforeRun = await workspace.repository.snapshot();
    const run = await request("POST", `/api/workflows/${draft.id}/run`, {
      mode: "async-operation", idempotencyKey: "synthetic-model-switch-runtime-0001", expectedActorId: "qa", input: {},
    }, 202);
    const saved = await waitFor(`/api/executions/${run.id}`, ["PENDING", "RUNNING"]);
    assert.equal(saved.status, "DONE");
    const rows = saved.stepOutputs.departments.structuredContent.data;
    assert.equal(saved.finalOutput.structuredContent.departmentCount, rows.length);
    const afterRun = await workspace.repository.snapshot();
    const invocations = Object.values(afterRun.invocationProvenance).filter(value => !beforeRun.invocationProvenance[value.id]);
    assert.ok(invocations.length > 0); assert.ok(invocations.every(value => value.model === modelA));
    assert.equal(afterRun.chats.qa_chat.selectedModel, modelB);
    console.log(`LOCAL Docker saved runtime node: ${modelA}, actual count ${rows.length}; chat remains ${modelB}.`);

    runtime.activate({ ...original, additionalModels: [] });
    const beforeDenied = await workspace.repository.snapshot();
    await request("POST", "/api/chat/sessions/qa_chat/messages", {
      content: "List the synthetic Departments from ERPBridge.", delivery: "async-chat", idempotencyKey: "synthetic-model-removed-0001",
    }, 422);
    const afterDenied = await workspace.repository.snapshot();
    assert.deepEqual(afterDenied.chats.qa_chat.messages, beforeDenied.chats.qa_chat.messages);
    assert.deepEqual(afterDenied.chatOperations, beforeDenied.chatOperations);
    assert.deepEqual(afterDenied.invocationProvenance, beforeDenied.invocationProvenance);
    console.log("LOCAL removed model: rejected before admission/provider entry; no silent replacement. Real-provider qualification remains open.");
  } finally { await workspace.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main(process.argv.slice(2));

import assert from "node:assert/strict";
import { stringify } from "yaml";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../src/parser/workflow.js";
import { PROTECTED_GROUP_PATCH_SYSTEM_PROMPT } from "../src/prompts/contracts.js";

const ref = (nodeId, ...path) => ({ kind: "ref", source: "nodeOutput", nodeId, path });
const literal = value => ({ kind: "literal", value });
const patches = {
  "LOCAL protected output edit": { output: { schema: { type: "string" }, success: ref("lookup_body", "structuredContent", "id"), handled: ref("guard", "error", "code") } },
  "LOCAL protected structured output": { output: {
    schema: { type: "object", properties: { completedBody: { type: "boolean" }, detail: { type: "string" } }, required: ["completedBody", "detail"], additionalProperties: false },
    success: { kind: "object", fields: { completedBody: literal(true), detail: ref("lookup_body", "structuredContent", "id") } },
    handled: { kind: "object", fields: { completedBody: literal(false), detail: ref("lookup_handler", "structuredContent", "id") } },
  } },
};

/** Synthetic provider only; no network, approval, publication or ERP dispatch. */
export function firestoreProtectedPatchResponse(request) {
  if (!request.messages[0].content.includes("ONE SELECTED PROTECTED GROUP PATCH")) return undefined;
  assert.equal(request.messages[0].content, PROTECTED_GROUP_PATCH_SYSTEM_PROMPT);
  const data = JSON.parse(request.messages[1].content), patch = patches[data.instruction];
  assert(patch, "Only exact synthetic protected-edit requests are accepted"); assert.deepEqual(data.tools, []);
  assert.equal(data.protectedGroupPatchVersion, "prompt/protected-group-patch/v1");
  const { success, handled } = data.allowedProtectedSources;
  assert(success.some(source => source.expression === "{{lookup_body.structuredContent.id}}"));
  assert(!success.some(source => source.binding.nodeId === "lookup_handler" || source.expression === "{{guard.error.code}}"));
  assert(handled.some(source => source.expression === "{{guard.error.code}}"));
  assert(handled.some(source => source.expression === "{{lookup_handler.structuredContent.id}}"));
  assert(!handled.some(source => source.binding.nodeId === "lookup_body"));
  for (const sources of [success, handled]) assert(!sources.some(source => source.expression.includes("guard.value") || source.expression.includes("token")));
  return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(patch) } }], usage: { prompt_tokens: 5, completion_tokens: 7 } });
}

export async function verifyFirestoreProtectedProposals({ request, repository: getRepository, restart, calls, models, log }) {
  const workflowId = "protected_chat_edit", source = stringify({ name: "Protected chat fixture", description: "Synthetic selected-group output editing, never execution", trigger: { type: "manual" },
    steps: [{ id: "lookup_body", action: "fixture.employee-read", parameters: { id: "body" } }, { id: "lookup_handler", action: "read", parameters: { id: "{{guard.error.code}}" } }],
    metadata: { ownerNotes: "preserved", controlFlow: { schemaVersion: "read-control-flow/v4", root: { kind: "sequence", nodes: [{ kind: "protect", id: "guard", onError: { code: "ERP_RESOURCE_NOT_FOUND" },
      body: { kind: "sequence", nodes: [{ kind: "action", nodeId: "lookup_body" }] }, handler: { kind: "sequence", nodes: [{ kind: "action", nodeId: "lookup_handler" }] },
      output: { schema: { type: "string" }, success: ref("lookup_body", "structuredContent", "id"), handled: literal("Old explicit fixture fallback") } }] } } } });
  await getRepository().mutate(state => {
    state.workflows[workflowId] = { ...structuredClone(state.workflows.collection_edit), id: workflowId, name: "Protected chat fixture", yaml: source, draftVersion: 1, publishedVersion: 0, canRun: false, steps: 2 };
    state.versions[workflowId] = [];
  });
  const chatId = (await request("POST", "/api/chat/sessions", {}, 201)).data.id, initialCalls = calls.length, initialModels = models.length;
  const initialExecutions = structuredClone((await getRepository().snapshot()).executions);
  let currentSource = source, revision = 1;
  for (const [index, [content, patch]] of Object.entries(patches).entries()) {
    const hash = workflowContentHash(currentSource), payload = { content, delivery: "async-chat", model: "fixture-model-b", idempotencyKey: `firestore-protected-patch-fixture-${index}`,
      nodeContext: { workflowId, nodeId: "guard", baseVersion: revision, baseHash: hash } };
    const opId = (await request("POST", `/api/chat/sessions/${chatId}/messages`, payload, 202)).data.operation.id, deadline = Date.now() + 15_000;
    while (["QUEUED", "RUNNING"].includes((await getRepository().snapshot()).chatOperations[opId]?.status)) {
      assert(Date.now() < deadline, "Protected proposal must terminate"); await new Promise(resolve => setTimeout(resolve, 10));
    }
    const saved = await getRepository().snapshot(), proposal = saved.chats[chatId].messages.at(-1).artifacts?.proposal;
    assert.equal(saved.chatOperations[opId].status, "ANSWERED"); assert.deepEqual(saved.chatOperations[opId].attempts, []);
    assert.equal(proposal.validation.passed, true, JSON.stringify(proposal.validation)); assert.equal(proposal.modelBinding.model, "fixture-model-b");
    assert.deepEqual(proposal.command, { type: "updateProtected", nodeId: "guard", patch }); assert.equal(saved.workflows[workflowId].yaml, currentSource);
    for (const field of ["id", "kind", "body", "handler", "onError"]) assert.deepEqual(proposal.after[field], proposal.before[field]);
    const visible = (await request("GET", `/api/chat/sessions/${chatId}`, undefined, 200)).data.messages;
    await restart(); assert.deepEqual((await request("GET", `/api/chat/sessions/${chatId}`, undefined, 200)).data.messages, visible);
    await request("GET", `/api/chat/operations/${opId}`, undefined, 404, "other");
    assert.equal((await request("POST", `/api/chat/sessions/${chatId}/messages`, payload, 202)).data.operation.id, opId);
    const apply = { baseVersion: revision, baseHash: hash, proposalId: proposal.id, command: proposal.command };
    await request("POST", `/api/workflows/${workflowId}/commands`, apply, 404, "other");
    await request("POST", `/api/workflows/${workflowId}/commands`, { ...apply, command: { ...proposal.command, patch: patches[Object.keys(patches)[1 - index]] } }, 409);
    if (index === 1) {
      const persistence = getRepository().persistence, original = persistence.records.db.runTransaction.bind(persistence.records.db);
      let lost = false;
      persistence.records.db.runTransaction = async (callback, options) => {
        let committedHead = false;
        const result = await original(async transaction => {
          const set = transaction.set;
          transaction.set = function (ref, ...args) { if (ref.path === persistence.records.headPath) committedHead = true; return set.call(this, ref, ...args); };
          try { return await callback(transaction); } finally { transaction.set = set; }
        }, options);
        if (committedHead && !lost) { lost = true; throw new Error("Synthetic protected patch post-COMMIT ACK lost"); }
        return result;
      };
      try { const uncertain = await request("POST", `/api/workflows/${workflowId}/commands`, apply, 503); assert(lost); assert.equal(uncertain.meta.code, "DRAFT_SAVE_UNCONFIRMED"); }
      finally { persistence.records.db.runTransaction = original; }
      await getRepository().recoverPersistenceState(); await restart();
    } else await request("POST", `/api/workflows/${workflowId}/commands`, apply, 200);
    revision++;
    const ready = (await request("GET", `/api/workflows/${workflowId}/readiness`, undefined, 200)).data;
    assert.equal(ready.version, revision); assert.equal(ready.publishedVersion, 0); assert.equal(ready.canRun, false); assert.equal(ready.can_attempt_run, false);
    const next = parseWorkflowYAMLStrict(ready.yaml), before = parseWorkflowYAMLStrict(currentSource), state = await getRepository().snapshot();
    assert.deepEqual(next.steps, before.steps); assert.equal(next.metadata.ownerNotes, "preserved"); assert.deepEqual(next.metadata.controlFlow.root.nodes[0], proposal.after);
    assert.equal(ready.authoring.protectedGroups[0].patchVersion, "prompt/protected-group-patch/v1");
    assert.equal(state.chats[chatId].messages.at(-1).artifacts.proposal.status, "APPLIED"); assert.equal(state.versions[workflowId].filter(value => value.version === revision).length, 1);
    assert.deepEqual(state.executions, initialExecutions); await request("POST", `/api/workflows/${workflowId}/commands`, apply, 409);
    currentSource = ready.yaml; await restart(); assert.equal((await getRepository().snapshot()).workflows[workflowId].yaml, currentSource);
    assert.equal(calls.length, initialCalls); assert.equal(models.length, initialModels + index + 1);
  }
  log("actual Firestore protected-group output/structured mapping proposals survived reopen, exact actor/revision-bound Apply and post-COMMIT ACK loss with immutable paths/policy and zero publication, execution or SDK calls");
}

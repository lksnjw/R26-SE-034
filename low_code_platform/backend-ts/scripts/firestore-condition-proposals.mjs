import assert from "node:assert/strict";
import { stringify } from "yaml";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../src/parser/workflow.js";
import { CONDITION_EDIT_PATCH_SYSTEM_PROMPT } from "../src/prompts/contracts.js";

const reference = nodeId => ({ kind: "ref", source: "nodeOutput", nodeId, path: ["structuredContent", "id"] });
const merge = { schema: { type: "string" }, then: reference("lookup_yes"), else: reference("lookup_no") };
const patches = {
  "LOCAL condition output add": { merge },
  "LOCAL condition output edit": { predicate: { kind: "literal", value: false }, merge: { ...merge, else: { kind: "literal", value: "Explicit No fixture output" } } },
  "LOCAL condition output remove": { merge: null },
};

// Network-free provider fixture. Matching the active instructions is part of
// qualification; this function cannot approve, publish or invoke the bridge.
export function firestoreConditionPatchResponse(request) {
  if (!request.messages[0].content.includes("ONE SELECTED CONDITION PATCH")) return undefined;
  assert.equal(request.messages[0].content, CONDITION_EDIT_PATCH_SYSTEM_PROMPT);
  const data = JSON.parse(request.messages[1].content), patch = patches[data.instruction];
  assert(patch, "Only exact synthetic condition-edit requests are accepted"); assert.deepEqual(data.tools, []);
  assert(data.allowedMergeSources.then.some(source => source.binding.nodeId === "lookup_yes"));
  assert(!data.allowedMergeSources.then.some(source => source.binding.nodeId === "lookup_no"));
  assert(data.allowedMergeSources.else.some(source => source.binding.nodeId === "lookup_no"));
  assert(!data.allowedMergeSources.else.some(source => source.binding.nodeId === "lookup_yes"));
  return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(patch) } }], usage: { prompt_tokens: 5, completion_tokens: 7 } });
}

export async function verifyFirestoreConditionProposals({ request, repository: getRepository, restart, calls, models, log }) {
  const workflowId = "condition_chat_edit", source = stringify({ name: "Condition chat fixture", description: "Selected-output editing with no execution", trigger: { type: "manual" },
    steps: ["lookup_yes", "lookup_no"].map(id => ({ id, action: "read", parameters: { id } })),
    metadata: { controlFlow: { schemaVersion: "read-control-flow/v1", root: { kind: "sequence", nodes: [{ kind: "if", id: "gate", predicate: { kind: "literal", value: true },
      then: { kind: "sequence", nodes: [{ kind: "action", nodeId: "lookup_yes" }] }, else: { kind: "sequence", nodes: [{ kind: "action", nodeId: "lookup_no" }] } }] } } } });
  await getRepository().mutate(state => {
    const template = state.workflows.collection_edit;
    state.workflows[workflowId] = { ...structuredClone(template), id: workflowId, name: "Condition chat fixture", yaml: source, draftVersion: 1, publishedVersion: 0, canRun: false, steps: 2 };
    state.versions[workflowId] = [];
  });
  const chatId = (await request("POST", "/api/chat/sessions", {}, 201)).data.id, initialCalls = calls.length, initialModels = models.length;
  const initialExecutions = structuredClone((await getRepository().snapshot()).executions);
  let currentSource = source, revision = 1;
  for (const [index, [content, patch]] of Object.entries(patches).entries()) {
    const hash = workflowContentHash(currentSource), payload = { content, delivery: "async-chat", model: "fixture-model-b", idempotencyKey: `firestore-condition-patch-fixture-${index}`,
      nodeContext: { workflowId, nodeId: "gate", baseVersion: revision, baseHash: hash } };
    const opId = (await request("POST", `/api/chat/sessions/${chatId}/messages`, payload, 202)).data.operation.id;
    const deadline = Date.now() + 15_000;
    while (["QUEUED", "RUNNING"].includes((await getRepository().snapshot()).chatOperations[opId]?.status)) {
      assert(Date.now() < deadline, "Condition proposal must terminate"); await new Promise(resolve => setTimeout(resolve, 10));
    }
    const saved = await getRepository().snapshot(), proposal = saved.chats[chatId].messages.at(-1).artifacts?.proposal;
    assert.equal(saved.chatOperations[opId].status, "ANSWERED"); assert.deepEqual(saved.chatOperations[opId].attempts, []);
    assert.equal(proposal.validation.passed, true); assert.equal(proposal.status, "PROPOSED"); assert.equal(proposal.modelBinding.model, "fixture-model-b");
    assert.deepEqual(proposal.command, { type: "updateCondition", nodeId: "gate", patch }); assert.equal(saved.workflows[workflowId].yaml, currentSource);
    assert.deepEqual(proposal.after.then, proposal.before.then); assert.deepEqual(proposal.after.else, proposal.before.else);
    if (patch.merge === null) assert(!Object.hasOwn(proposal.after, "merge"));
    const visibleMessages = (await request("GET", `/api/chat/sessions/${chatId}`, undefined, 200)).data.messages;
    await restart();
    assert.deepEqual((await getRepository().snapshot()).chats[chatId].messages, saved.chats[chatId].messages);
    assert.deepEqual((await request("GET", `/api/chat/sessions/${chatId}`, undefined, 200)).data.messages, visibleMessages);
    // Both fixture users are administrators allowed to read workspace chats;
    // operation ownership and exact proposal application remain actor-scoped.
    await request("GET", `/api/chat/operations/${opId}`, undefined, 404, "other");
    assert.equal((await request("POST", `/api/chat/sessions/${chatId}/messages`, payload, 202)).data.operation.id, opId);
    assert.equal(models.length, initialModels + index + 1); assert.equal(calls.length, initialCalls);
    const applyPayload = { baseVersion: revision, baseHash: hash, proposalId: proposal.id, command: proposal.command };
    await request("POST", `/api/workflows/${workflowId}/commands`, applyPayload, 404, "other");
    if (index === 2) {
      // Lose the HTTP save acknowledgement only AFTER Firestore committed the
      // proposal resolution and draft revision in its normal head transaction.
      const persistence = getRepository().persistence, original = persistence.records.db.runTransaction.bind(persistence.records.db);
      let lost = false;
      persistence.records.db.runTransaction = async (callback, options) => {
        let committedHead = false;
        const result = await original(async transaction => {
          const set = transaction.set;
          transaction.set = function (ref, ...args) { if (ref.path === persistence.records.headPath) committedHead = true; return set.call(this, ref, ...args); };
          try { return await callback(transaction); } finally { transaction.set = set; }
        }, options);
        if (committedHead && !lost) { lost = true; throw new Error("Synthetic condition patch post-COMMIT ACK lost"); }
        return result;
      };
      try {
        const uncertain = await request("POST", `/api/workflows/${workflowId}/commands`, applyPayload, 503);
        assert(lost); assert.equal(uncertain.meta.code, "DRAFT_SAVE_UNCONFIRMED"); assert(!uncertain.message.includes("nothing was changed"));
      } finally { persistence.records.db.runTransaction = original; }
      await getRepository().recoverPersistenceState(); await restart();
    } else await request("POST", `/api/workflows/${workflowId}/commands`, applyPayload, 200);
    revision++;
    const ready = (await request("GET", `/api/workflows/${workflowId}/readiness`, undefined, 200)).data;
    assert.equal(ready.version, revision); assert.equal(ready.publishedVersion, 0); assert.equal(ready.canRun, false); assert.equal(ready.can_attempt_run, false);
    const next = parseWorkflowYAMLStrict(ready.yaml), before = parseWorkflowYAMLStrict(currentSource);
    assert.deepEqual(next.steps, before.steps); assert.deepEqual(next.metadata.controlFlow.root.nodes[0], proposal.after);
    const state = await getRepository().snapshot(); assert.equal(state.chats[chatId].messages.at(-1).artifacts.proposal.status, "APPLIED");
    assert.equal(state.versions[workflowId].filter(value => value.version === revision).length, 1); assert.deepEqual(state.executions, initialExecutions);
    await request("POST", `/api/workflows/${workflowId}/commands`, applyPayload, 409);
    currentSource = ready.yaml;
    await restart(); assert.equal((await getRepository().snapshot()).workflows[workflowId].yaml, currentSource);
    assert.equal(calls.length, initialCalls); assert.equal(models.length, initialModels + index + 1);
  }
  log("actual Firestore condition chat add/combined edit/null removal survived proposal reopen, exact once-only Apply and post-COMMIT save ACK loss; branches/IDs/versions preserved with zero publication, execution or SDK calls");
}

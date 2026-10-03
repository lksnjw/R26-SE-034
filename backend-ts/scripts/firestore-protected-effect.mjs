import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { stringify } from "yaml";
import { workflowContentHash } from "../src/parser/workflow.js";
import { publishProtectedOperation, assertStoredProtectedOperationPublicationCurrent } from "../src/workflows/protected-operation-publication.js";
import { ProtectedMachine } from "../src/workflows/protected-machine.js";
import { ProtectedInvocationLedger } from "../src/runner/protected-invocation-ledger.js";
import { newReadProgress } from "../src/runner/read-checkpoints.js";
import { protectedAdmissionSeal, protectedHash as hash, restoreProtectedJob, sealProtectedCursor } from "../src/runner/protected-job-state.js";
import { admitProtectedOperation } from "../src/runner/protected-job-admission.js";
import { runProtectedOperation } from "../src/runner/protected-job-worker.js";
import { publicExecution } from "../src/redact/public-model-usage.js";

/** Actual encrypted/scoped Firestore emulator persistence and genuine owned
 * SDK facade, with synthetic SDK I/O. The initial QUEUED job is explicitly
 * TEST ONLY and server sealed under a current publication: public admission
 * stays closed. No supplied result/permit/consumption or legacy journal.
 * Reopen means same Node process/server/repository, not OS-process recovery. */
export async function verifyFirestoreProtectedEffect({ repository, services, request, restart, tool, calls, models, operations, emails, waitFor, log }) {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:23671");
  assert.equal(process.env.GCLOUD_PROJECT, "demo-lcwe-records"); assert(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
  const counts = { calls: calls.length, models: models.length, operations: operations.length, emails: emails.length };
  await request("PATCH", "/api/settings/rbac", { runtimeApprovalPolicy: { profile: "runtime-approval-policy/v1", baseRevision: 0,
    enabled: true, approverRoleIds: ["role_admin"], ttlSeconds: 60, separationOfDuties: true } }, 200);
  const source = { name: "Test-only private owned effect", description: "Synthetic SDK acceptance with real local storage",
    trigger: { type: "manual", config: { inputSchema: { type: "object", properties: { items: { type: "array", items: { type: "string" } } },
      required: ["items"], additionalProperties: false } } },
    steps: [{ id: "send", action: tool.name, parameters: { id: "{{each.item}}" } }],
    metadata: { controlFlow: { schemaVersion: "read-control-flow/v4", root: { kind: "sequence", nodes: [
      { kind: "foreach", id: "each", maxItems: 2, items: { schema: { type: "array", items: { type: "string" } },
        value: { kind: "ref", source: "workflowInput", path: ["items"] } }, body: { kind: "sequence", nodes: [{ kind: "action", nodeId: "send" }] },
        collect: { schema: { type: "boolean" }, value: { kind: "ref", source: "nodeOutput", nodeId: "send", path: ["structuredContent", "accepted"] } } },
      { kind: "return", id: "answer", output: { schema: { type: "array", items: { type: "boolean" } },
        value: { kind: "ref", source: "nodeOutput", nodeId: "each", path: ["value"] } } },
    ] } } } };
  const seed = async (name, items) => {
    const workflowId = `private_effect_${name}`, id = `private-effect-${randomUUID()}`;
    await repository().mutate(state => {
      state.workflows[workflowId] = { ...structuredClone(state.workflows.single), id: workflowId, name: source.name,
        yaml: stringify(source), steps: 1, publishedVersion: 0, draftVersion: 1, canRun: false }; state.versions[workflowId] = [];
    });
    const actor = await repository().effectiveUser("owner"), workflow = (await repository().snapshot()).workflows[workflowId];
    const publication = await publishProtectedOperation(services(), workflowId, actor, { baseVersion: 1, baseHash: workflowContentHash(workflow.yaml) });
    await assert.rejects(admitProtectedOperation(services(), workflowId, actor, { items }, `effect-admission-closed-${name}-0001`), /drivers/);
    await repository().mutate(state => {
      const version = state.versions[workflowId].find(item => item.id === publication.id);
      const plan = assertStoredProtectedOperationPublicationCurrent(state, services(), version.id, workflowId, actor.role);
      const input = { items }, createdAt = new Date().toISOString(), machine = new ProtectedMachine(plan.machine, input); machine.peek();
      const ledger = new ProtectedInvocationLedger({ executionId: id, workflowId, actorId: actor.id, roleId: actor.roleId, admittedRole: actor.role,
        sourceHash: plan.sourceHash, operationHash: plan.semanticHash, machineHash: plan.machine.semanticHash, inputHash: hash(input) }, plan.machine, machine);
      const run = { id, workflowId, workflowName: source.name, status: "PENDING", startedBy: { id: actor.id, name: actor.name },
        startedAt: createdAt, completedAt: null, durationMs: 0, costUsd: 0, tokens: { input: 0, output: 0, total: 0 }, stepOutputs: {},
        readProgress: newReadProgress(repository()), workflowSnapshot: { yaml: version.yaml, version: publication.version,
          contentHash: plan.sourceHash, registryHash: version.protectedCompilation.registryHash, input, executionProfile: "protected-operation-v1",
          protectedCompilation: structuredClone(version.protectedCompilation) }, protectedInvocationSecret: ledger.snapshot(),
        protectedJobSecret: { profile: "protected-operation-job/v1", actorId: actor.id, roleId: actor.roleId, admittedRole: actor.role,
          departmentId: actor.departmentId, permissionsHash: hash([...new Set(actor.permissions)].sort()), publicationId: version.id,
          idempotencyScope: hash(["test-only-owned-effect", id]), requestFingerprint: hash({ workflowId, input }),
          createdAt, state: "QUEUED", admissionSeal: "0".repeat(64) } };
      run.protectedJobSecret.admissionSeal = protectedAdmissionSeal(services(), run);
      state.executions[id] = run; state.timelines[id] = []; state.executionEvents[id] = []; state.executionLogs[id] = [];
      sealProtectedCursor(services(), state, run, machine);
    });
    return { id, workflowId, items };
  };
  const saved = f => repository().readAuthoritative(state => {
    const run = state.executions[f.id]; restoreProtectedJob(state, services(), f.id);
    assert(!JSON.stringify(publicExecution(run)).match(/protectedApprovalSecret|protectedInvocationSecret|protectedJobSecret|admissionSeal|intentKey|sdkReceipt/));
    return structuredClone(run);
  });
  const active = run => run.protectedApprovalSecret.records[run.protectedApprovalSecret.activeId];
  const run = f => runProtectedOperation(services(), f.id);
  const reopenExact = async f => { const before = await saved(f); await restart(); assert.deepEqual(await saved(f), before); return before; };
  const approve = async f => {
    const row = active(await saved(f)), before = operations.length;
    const command = { approvalId: row.id, baseVersion: row.version, reviewHash: row.reviewHash,
      decisionKey: `test-effect-decision-${row.id}`, note: "Approve only this original exact item" };
    const decision = await request("POST", `/api/executions/${f.id}/approve`, command, 200, "other");
    assert.equal(decision.data.state, "APPROVED"); assert.equal(decision.data.resumeQueued, false); assert.equal(operations.length, before);
    const approved = active(await saved(f)); assert.equal(approved.state, "APPROVED");
    const replay = await request("POST", `/api/executions/${f.id}/approve`, command, 200, "other");
    assert.equal(replay.data.replayed, true); assert.equal(operations.length, before);
    return { row: approved, command };
  };
  const originalReview = (value, original) => {
    for (const key of ["id", "requestedAt", "expiresAt", "reviewHash"]) assert.equal(value[key], original[key]);
    assert.equal(value.binding.intentId, original.binding.intentId); assert.equal(value.binding.intentKey, original.binding.intentKey);
    assert.deepEqual(value.decision, original.decision);
  };
  const success = await seed("roundtrip", ["identical-effect-item", "identical-effect-item"]);
  assert.equal((await run(success)).status, "AWAITING_APPROVAL"); assert.equal(operations.length, counts.operations);
  await reopenExact(success); const first = await approve(success); await reopenExact(success);
  assert.equal((await run(success)).status, "AWAITING_APPROVAL"); assert.equal(operations.length, counts.operations + 1);
  let stored = await saved(success), consumed = stored.protectedApprovalSecret.records[first.row.id], second = active(stored);
  originalReview(consumed, first.row); assert.equal(consumed.state, "CONSUMED"); assert(consumed.consumption.epoch > first.row.binding.requestEpoch);
  assert.equal(consumed.sdkReceipt.meaning, "operation-accepted"); assert.equal(stored.protectedInvocationSecret.intents[first.row.binding.intentKey].state, "ACKNOWLEDGED");
  assert.equal(consumed.sdkReceipt.remoteName, "fixture.notification.rev_MS4wLjA"); assert.equal(consumed.sdkReceipt.resourceDigest, "b".repeat(64));
  assert.equal(second.state, "PENDING"); assert.equal(second.binding.invocationId, "each/1/send"); assert.notEqual(second.id, first.row.id);
  assert.deepEqual(stored.stepOutputs["each/0/send"].structuredContent, { accepted: true, id: "identical-effect-item" });
  assert.equal((await run(success)).status, "AWAITING_APPROVAL"); assert.equal(operations.length, counts.operations + 1);
  await reopenExact(success); await approve(success);
  const result = await run(success); assert.equal(result.status, "DONE"); assert.deepEqual(result.finalOutput, [true, true]);
  assert.deepEqual(Object.keys(result.stepOutputs), ["each/0/send", "each/1/send"]); assert.equal(operations.length, counts.operations + 2);
  await reopenExact(success); assert.equal((await run(success)).status, "DONE"); assert.equal(operations.length, counts.operations + 2);
  const replay = await request("POST", `/api/executions/${success.id}/approve`, first.command, 200, "other");
  assert.equal(replay.data.replayed, true); assert.equal(operations.length, counts.operations + 2);
  log("actual Firestore private owned effects preserved first intent/TTL/key, required a separate second-item approval for identical arguments, and reopened wait/approval/answers without SDK replay");

  for (const scenario of [
    { stage: "consumption", phase: "before", intent: "PREPARING", status: "DONE", calls: 1 },
    { stage: "consumption", phase: "after", intent: "DISPATCH_INTENT", status: "RECOVERY_REQUIRED", calls: 0 },
    { stage: "answer", phase: "before", intent: "DISPATCH_INTENT", status: "RECOVERY_REQUIRED", calls: 1 },
    { stage: "answer", phase: "after", intent: "ACKNOWLEDGED", status: "DONE", calls: 1 },
  ]) {
    const f = await seed(`${scenario.stage}_${scenario.phase}`, [`effect-${scenario.stage}-${scenario.phase}`]), before = operations.length;
    assert.equal((await run(f)).status, "AWAITING_APPROVAL"); const original = await approve(f);
    const persistence = repository().persistence, writer = persistence.saveExecutionCheckpoint.bind(persistence); let injected = false;
    persistence.saveExecutionCheckpoint = async checkpoint => {
      const row = checkpoint.execution?.protectedApprovalSecret?.records[original.row.id];
      if (!injected && checkpoint.executionId === f.id && row?.state === "CONSUMED" && (scenario.stage === "answer" ? !!row.sdkReceipt : !row.sdkReceipt)) {
        injected = true; if (scenario.phase === "after") await writer(checkpoint);
        throw new Error(`Synthetic protected effect ${scenario.phase}-COMMIT ${scenario.stage} acknowledgement loss`);
      }
      return writer(checkpoint);
    };
    try {
      await assert.rejects(run(f)); assert(injected); assert.throws(() => repository().assertAuthority());
      await assert.rejects(run(f)); assert.equal(operations.length - before, scenario.stage === "answer" ? 1 : 0);
    } finally { persistence.saveExecutionCheckpoint = writer; }
    await repository().recoverPersistenceState(); stored = await saved(f);
    originalReview(stored.protectedApprovalSecret.records[original.row.id], original.row);
    assert.equal(stored.protectedInvocationSecret.intents[original.row.binding.intentKey].state, scenario.intent);
    if (scenario.stage === "answer" && scenario.phase === "after") {
      assert.equal(stored.stepOutputs["each/0/send"].structuredContent.accepted, true);
      assert.equal(stored.protectedApprovalSecret.records[original.row.id].sdkReceipt.meaning, "operation-accepted");
    } else assert.deepEqual(stored.stepOutputs, {});
    await reopenExact(f);
    // Natural expiry of the original five-second worker lease. No saved lease
    // or approval deadline is rewritten to manufacture a successful takeover.
    await waitFor(async () => { const job = (await saved(f)).protectedJobSecret; return job.state !== "CLAIMED" || job.lease.expiresAt <= Date.now(); },
      `effect ${scenario.stage}-${scenario.phase} original worker lease expiry`);
    const resumed = await run(f); assert.equal(resumed.status, scenario.status); assert.equal(operations.length - before, scenario.calls);
    if (scenario.status === "DONE") assert.deepEqual(resumed.finalOutput, [true]); else assert.deepEqual(resumed.stepOutputs, {});
    const final = await saved(f); originalReview(final.protectedApprovalSecret.records[original.row.id], original.row);
    await reopenExact(f); assert.equal((await run(f)).status, scenario.status); assert.equal(operations.length - before, scenario.calls);
    log(`actual Firestore protected effect ${scenario.phase}-COMMIT ${scenario.stage} loss fenced old authority; authoritative same-process reopen produced ${scenario.status} with ${scenario.calls} total SDK calls and original review TTL/key`);
  }
  assert.equal(calls.length, counts.calls); assert.equal(models.length, counts.models); assert.equal(emails.length, counts.emails);
  assert.equal(operations.length - counts.operations, 5);
  console.log("Focused private owned effect qualification complete: actual local Firestore and genuine governed facade with injected synthetic SDK I/O, separate exact-item approvals, four COMMIT-loss cases and same-process reopen. Public v9/effect admission, recovery resolution, report/schedule/email, OS-process restart, live ERP/model and production acceptance remain unqualified.");
}

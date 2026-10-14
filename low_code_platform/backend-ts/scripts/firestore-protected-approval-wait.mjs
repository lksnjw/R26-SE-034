import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { stringify } from "yaml";
import { workflowContentHash } from "../src/parser/workflow.js";
import { publishProtectedOperation, assertStoredProtectedOperationPublicationCurrent } from "../src/workflows/protected-operation-publication.js";
import { ProtectedMachine } from "../src/workflows/protected-machine.js";
import { ProtectedInvocationLedger } from "../src/runner/protected-invocation-ledger.js";
import { newReadProgress } from "../src/runner/read-checkpoints.js";
import { protectedAdmissionSeal, protectedHash as hash, restoreProtectedJob, sealProtectedCursor } from "../src/runner/protected-job-state.js";
import { createOwnedProtectedApprovalWait, settleProtectedApprovalWait } from "../src/runner/protected-approval-wait.js";
import { decideOwnedProtectedApproval } from "../src/runner/protected-approval-review.js";
import { admitProtectedOperation } from "../src/runner/protected-job-admission.js";
import { publicExecution } from "../src/redact/public-model-usage.js";

/** Actual encrypted application persistence and authenticated reviewer HTTP.
 * CLAIMED jobs are explicitly TEST-ONLY server-sealed fixtures, not admitted
 * production effects. No synthetic SDK answer, effect call or dispatch permit
 * is created. Same Node/server/repository reopen, not OS-process qualification. */
export async function verifyFirestoreProtectedApprovalWait({ repository, services, request, restart, tool, calls, models, operations, emails, log }) {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:23671");
  assert.equal(process.env.GCLOUD_PROJECT, "demo-lcwe-records"); assert(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
  const counts = [calls.length, models.length, operations.length, emails.length];
  await request("PATCH", "/api/settings/rbac", { runtimeApprovalPolicy: { profile: "runtime-approval-policy/v1", baseRevision: 0,
    enabled: true, approverRoleIds: ["role_admin"], ttlSeconds: 60, separationOfDuties: true } }, 200);
  const source = { name: "Synthetic private owned approval wait", description: "No admitted effect or business call",
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
  const seed = async name => {
    const workflowId = `private_approval_${name}`, id = `private-approval-${randomUUID()}`;
    await repository().mutate(state => {
      state.workflows[workflowId] = { ...structuredClone(state.workflows.single), id: workflowId, name: source.name,
        yaml: stringify(source), steps: 1, publishedVersion: 0, draftVersion: 1, canRun: false }; state.versions[workflowId] = [];
    });
    const actor = await repository().effectiveUser("owner"), workflow = (await repository().snapshot()).workflows[workflowId];
    const publication = await publishProtectedOperation(services(), workflowId, actor, { baseVersion: 1, baseHash: workflowContentHash(workflow.yaml) });
    const owner = { workerId: `synthetic-worker-${id}`, leaseId: `synthetic-lease-${id}`, epoch: 1 };
    await repository().mutate(state => {
      const version = state.versions[workflowId].find(item => item.id === publication.id);
      const plan = assertStoredProtectedOperationPublicationCurrent(state, services(), version.id, workflowId, actor.role);
      const input = { items: ["synthetic-private-item-A", "synthetic-private-item-B"] }, createdAt = new Date().toISOString();
      let machine = new ProtectedMachine(plan.machine, input); machine.peek();
      const identity = { executionId: id, workflowId, actorId: actor.id, roleId: actor.roleId, admittedRole: actor.role,
        sourceHash: plan.sourceHash, operationHash: plan.semanticHash, machineHash: plan.machine.semanticHash, inputHash: hash(input) };
      let ledger = new ProtectedInvocationLedger(identity, plan.machine, machine);
      while (machine.peek()?.kind !== "action") {
        const point = machine.peek(); assert(point);
        const typed = ["merge", "return", "collection-item"].includes(point.kind) || point.kind === "collection-complete" && point.outcome !== "FAILED";
        const next = ledger.advance(machine, { kind: "accept", ...(typed ? { output: { value: point.value } } : {}) });
        machine = next.machine; ledger = new ProtectedInvocationLedger(identity, plan.machine, machine, next.ledger);
      }
      const run = { id, workflowId, workflowName: source.name, status: "RUNNING", startedBy: { id: actor.id, name: actor.name },
        startedAt: createdAt, completedAt: null, durationMs: 0, costUsd: 0, tokens: { input: 0, output: 0, total: 0 }, stepOutputs: {},
        readProgress: newReadProgress(repository()), workflowSnapshot: { yaml: version.yaml, version: publication.version,
          contentHash: plan.sourceHash, registryHash: version.protectedCompilation.registryHash, input, executionProfile: "protected-operation-v1",
          protectedCompilation: structuredClone(version.protectedCompilation) }, protectedInvocationSecret: ledger.snapshot(),
        protectedJobSecret: { profile: "protected-operation-job/v1", actorId: actor.id, roleId: actor.roleId, admittedRole: actor.role,
          departmentId: actor.departmentId, permissionsHash: hash([...new Set(actor.permissions)].sort()), publicationId: version.id,
          idempotencyScope: hash(["synthetic-test-only-approval", id]), requestFingerprint: hash({ workflowId, input }),
          createdAt, state: "CLAIMED", admissionSeal: "0".repeat(64), lease: { id: owner.leaseId, workerId: owner.workerId, expiresAt: Date.now() + 60_000 } } };
      run.protectedJobSecret.admissionSeal = protectedAdmissionSeal(services(), run);
      state.executions[id] = run; state.timelines[id] = []; state.executionEvents[id] = []; state.executionLogs[id] = [];
      sealProtectedCursor(services(), state, run, machine);
    });
    return { id, workflowId, owner };
  };
  const saved = f => repository().readAuthoritative(state => {
    const run = state.executions[f.id]; restoreProtectedJob(state, services(), f.id);
    assert(!JSON.stringify(publicExecution(run)).match(/protectedApprovalSecret|protectedInvocationSecret|protectedJobSecret|admissionSeal|intentKey/));
    return structuredClone(run);
  });
  const wait = f => repository().mutateExecution(f.id, state => createOwnedProtectedApprovalWait(state, services(), f.id, f.owner));
  const record = run => run.protectedApprovalSecret.records[run.protectedApprovalSecret.activeId];
  const command = run => ({ approvalId: record(run).id, baseVersion: 1, reviewHash: record(run).reviewHash,
    decisionKey: `synthetic-decision-${run.id}`, note: "Exact first-item independent decision" });
  const cancel = f => repository().mutateExecution(f.id, state => {
    state.executions[f.id].readProgress.cancellation = { requestedAt: new Date().toISOString(), requestedBy: { id: "owner", name: "owner" } };
    assert.equal(settleProtectedApprovalWait(state, services(), f.id), true);
  });
  const expires = f => repository().mutateExecution(f.id, state => {
    const clock = Date.now, at = Date.parse(record(state.executions[f.id]).expiresAt);
    // Deterministic original-deadline boundary only, restored before the actual
    // asynchronous save/writer heartbeat. This is not a wall-clock latency test.
    Date.now = () => at; try { assert.equal(settleProtectedApprovalWait(state, services(), f.id), true); } finally { Date.now = clock; }
  });
  const reopenExact = async f => { const before = await saved(f); await restart(); assert.deepEqual(await saved(f), before); return before; };
  const success = await seed("roundtrip"); await wait(success); let run = await reopenExact(success);
  assert.equal(run.status, "AWAITING_APPROVAL"); assert.equal(record(run).binding.invocationId, "each/0/send");
  assert.deepEqual(record(run).arguments, { id: "synthetic-private-item-A" }); assert(!run.protectedJobSecret.lease);
  const original = command(run), view = await request("GET", `/api/executions/${success.id}?view=approval`, undefined, 200, "other");
  assert.equal(view.data.runtimeApproval.canDecide, true); assert.equal(view.data.runtimeApproval.invocationId, "each/0/send");
  assert(!JSON.stringify(view).match(/intentKey|connectionBinding|admissionSeal|protectedApprovalSecret/));
  await request("POST", `/api/executions/${success.id}/approve`, original, 200, "other"); run = await reopenExact(success);
  assert.equal(run.status, "BLOCKED"); assert.equal(record(run).state, "APPROVED");
  const replay = await request("POST", `/api/executions/${success.id}/approve`, original, 200, "other"); assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.resumeQueued, false); assert.deepEqual(await saved(success), run);
  await request("POST", `/api/executions/${success.id}/cancel`, {}, 200); run = await reopenExact(success);
  assert.equal(record(run).state, "CLOSED"); assert.equal(run.status, "CANCELLED");
  log("actual Firestore owned exact-item wait, authenticated approval and HTTP cancellation survived three reopen checkpoints; approved review stayed blocked and no effect ran");
  for (const stage of ["reject", "expiry"]) {
    const f = await seed(`roundtrip_${stage}`); await wait(f);
    if (stage === "reject") await request("POST", `/api/executions/${f.id}/reject`, command(await saved(f)), 200, "other"); else await expires(f);
    run = await reopenExact(f); assert.equal(record(run).state, stage === "reject" ? "REJECTED" : "EXPIRED"); assert.equal(run.status, "FAILED");
  }
  log("actual Firestore independent rejection and original-TTL expiry survived two terminal reopens without dispatch or approval renewal");
  for (const stage of ["wait", "approve", "reject", "cancel", "expiry"]) for (const phase of ["before", "after"]) {
    const f = await seed(`${phase}_${stage}`); if (stage !== "wait") await wait(f);
    const before = await saved(f), cmd = stage === "wait" ? undefined : command(before), persistence = repository().persistence;
    const writer = persistence.saveExecutionCheckpoint.bind(persistence); let injected = false;
    persistence.saveExecutionCheckpoint = async checkpoint => {
      if (checkpoint.executionId !== f.id || injected) return writer(checkpoint);
      injected = true; if (phase === "after") await writer(checkpoint); throw new Error(`Synthetic owned approval ${phase}-COMMIT loss`);
    };
    try {
      if (stage === "wait") await assert.rejects(wait(f));
      else if (["approve", "reject"].includes(stage)) {
        const actor = await repository().effectiveUser("other");
        await assert.rejects(decideOwnedProtectedApproval(services(), f.id, actor, cmd, stage === "approve" ? "APPROVED" : "REJECTED"),
          error => error.status === 503 && error.meta?.code === "PROTECTED_APPROVAL_SAVE_UNCONFIRMED");
      } else await assert.rejects(stage === "cancel" ? cancel(f) : expires(f));
      assert(injected); assert.throws(() => repository().assertAuthority());
    } finally { persistence.saveExecutionCheckpoint = writer; }
    await repository().recoverPersistenceState(); const recovered = await saved(f);
    if (phase === "before") assert.deepEqual(recovered, before); else {
      assert.notDeepEqual(recovered, before);
      assert.equal(record(recovered).state, { wait: "PENDING", approve: "APPROVED", reject: "REJECTED", cancel: "CLOSED", expiry: "EXPIRED" }[stage]);
    }
    await reopenExact(f);
    if (phase === "after" && ["approve", "reject"].includes(stage)) {
      const result = await request("POST", `/api/executions/${f.id}/${stage}`, cmd, 200, "other");
      assert.equal(result.data.replayed, true); assert.deepEqual(await saved(f), recovered);
    }
    if (phase === "after" && ["cancel", "expiry"].includes(stage)) {
      const damaged = await repository().snapshot(), item = damaged.executions[f.id];
      item.protectedJobSecret.state = "WAITING"; item.status = "AWAITING_APPROVAL"; item.completedAt = null; delete item.readProgress.cancellation;
      assert.throws(() => restoreProtectedJob(damaged, services(), f.id));
    }
    log(`actual owned approval ${phase}-COMMIT ${stage} loss fenced old authority; reopen retained precisely ${phase === "before" ? "the preceding" : "one committed"} state with zero effect calls`);
  }
  const actor = await repository().effectiveUser("owner");
  await assert.rejects(admitProtectedOperation(services(), success.workflowId, actor, { items: ["A"] }, "synthetic-effect-still-closed-0001"), /drivers/);
  assert.deepEqual([calls.length, models.length, operations.length, emails.length], counts);
  console.log("Owned approval wait qualification complete: five checkpoint/reopens and ten COMMIT-loss cases. Effect admission, genuine SDK permit/driver, recovery, normal v9, OS-process/live ERP/email and production remain unqualified.");
}

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
import { ProtectedJobCheckpoints } from "../src/runner/protected-job-checkpoints.js";
import { publicExecution } from "../src/redact/public-model-usage.js";

/** Real encrypted Firestore with synthetic SDK transport. Initial sealed
 * QUEUED records are TEST ONLY: normal public admission remains closed.
 * Restart closes/reopens the application inside this Node process. */
export async function verifyFirestoreProtectedReport({ repository, services, restart, tool, calls, models, reports, operations, emails, waitFor, log }) {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:23671");
  assert.equal(process.env.GCLOUD_PROJECT, "demo-lcwe-records"); assert(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
  const counts = { calls: calls.length, models: models.length, reports: reports.length, operations: operations.length, emails: emails.length };
  const source = { name: "Test-only protected paginated report", description: "Real local storage and synthetic SDK pages", trigger: { type: "manual", config: {
    inputSchema: { type: "object", properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"], additionalProperties: false } } },
    steps: [{ id: "report", action: tool.name, parameters: { startAt: "2026-10-01T00:00:00.000Z", endAt: "2026-10-02T00:00:00.000Z" } }],
    metadata: { controlFlow: { schemaVersion: "read-control-flow/v4", root: { kind: "sequence", nodes: [
      { kind: "foreach", id: "each", maxItems: 2, items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "workflowInput", path: ["items"] } },
        body: { kind: "sequence", nodes: [{ kind: "action", nodeId: "report" }] }, collect: { schema: { type: "integer" },
          value: { kind: "ref", source: "nodeOutput", nodeId: "report", path: ["structuredContent", "itemCount"] } } },
      { kind: "return", id: "answer", output: { schema: { type: "array", items: { type: "integer" } }, value: { kind: "ref", source: "nodeOutput", nodeId: "each", path: ["value"] } } },
    ] } } } };
  const seed = async (name, items = ["one"]) => {
    const workflowId = `private_report_${name}`, id = `private-report-${randomUUID()}`;
    await repository().mutate(state => { state.workflows[workflowId] = { ...structuredClone(state.workflows.single), id: workflowId, name: source.name,
      yaml: stringify(source), steps: 1, publishedVersion: 0, draftVersion: 1, canRun: false }; state.versions[workflowId] = []; });
    const actor = await repository().effectiveUser("owner"), publication = await publishProtectedOperation(services(), workflowId, actor,
      { baseVersion: 1, baseHash: workflowContentHash(stringify(source)) });
    await assert.rejects(admitProtectedOperation(services(), workflowId, actor, { items }, `report-public-closed-${name}-0001`), /drivers/);
    await repository().mutate(state => {
      const version = state.versions[workflowId].find(row => row.id === publication.id), plan = assertStoredProtectedOperationPublicationCurrent(state, services(), version.id, workflowId, actor.role);
      const input = { items }, machine = new ProtectedMachine(plan.machine, input); machine.peek();
      const ledger = new ProtectedInvocationLedger({ executionId: id, workflowId, actorId: actor.id, roleId: actor.roleId, admittedRole: actor.role,
        sourceHash: plan.sourceHash, operationHash: plan.semanticHash, machineHash: plan.machine.semanticHash, inputHash: hash(input) }, plan.machine, machine);
      const createdAt = new Date().toISOString(), run = { id, workflowId, workflowName: source.name, status: "PENDING", startedBy: { id: actor.id, name: actor.name },
        startedAt: createdAt, completedAt: null, durationMs: 0, costUsd: 0, tokens: { input: 0, output: 0, total: 0 }, stepOutputs: {}, readProgress: newReadProgress(repository()),
        workflowSnapshot: { yaml: version.yaml, version: publication.version, contentHash: plan.sourceHash, registryHash: version.protectedCompilation.registryHash,
          input, executionProfile: "protected-operation-v1", protectedCompilation: structuredClone(version.protectedCompilation) }, protectedInvocationSecret: ledger.snapshot(),
        protectedJobSecret: { profile: "protected-operation-job/v1", actorId: actor.id, roleId: actor.roleId, admittedRole: actor.role, departmentId: actor.departmentId,
          permissionsHash: hash([...new Set(actor.permissions)].sort()), publicationId: version.id, idempotencyScope: hash(["test-only-report", id]),
          requestFingerprint: hash({ workflowId, input }), createdAt, state: "QUEUED", admissionSeal: "0".repeat(64) } };
      run.protectedJobSecret.admissionSeal = protectedAdmissionSeal(services(), run); state.executions[id] = run;
      state.timelines[id] = []; state.executionEvents[id] = []; state.executionLogs[id] = []; sealProtectedCursor(services(), state, run, machine);
    }); return { id, items };
  };
  const saved = f => repository().readAuthoritative(state => { restoreProtectedJob(state, services(), f.id); const run = state.executions[f.id];
    assert(!JSON.stringify(publicExecution(run)).match(/reportPageSecret|protectedInvocationSecret|cursor-firestore|snapshot-firestore/)); return structuredClone(run); });
  const run = f => runProtectedOperation(services(), f.id);
  const reopen = async f => { const before = await saved(f); await restart(); assert.deepEqual(await saved(f), before); };
  const success = await seed("roundtrip", ["same", "same"]), before = reports.length;
  const cp = await ProtectedJobCheckpoints.claim(services(), success.id);
  try { await cp.initialize(); for (;;) { const point = await cp.next(); if (point.kind === "action") break; await cp.advanceControl(point); }
    await cp.executeReportBoundary(); await cp.yield(); } finally { cp.close(); }
  let stored = await saved(success); assert.deepEqual(stored.stepOutputs, {}); assert(!stored.reportCoverages);
  assert.equal(stored.reportPageSecret["each/0/report"].pages.length, 1); await reopen(success);
  let result = await run(success); assert.equal(result.status, "DONE"); assert.deepEqual(result.finalOutput, [3, 3]); assert.equal(reports.length - before, 6);
  stored = await saved(success); assert.deepEqual(Object.keys(stored.reportCoverages), ["each/0/report", "each/1/report"]); assert(!stored.reportPageSecret);
  assert.equal(stored.reportCoverages["each/0/report"].pagination.pageCount, 3); await reopen(success); assert.equal((await run(success)).status, "DONE"); assert.equal(reports.length - before, 6);
  log("actual Firestore protected report clean page yield/reopen resumed exact next cursor; identical items retained separate complete coverage and answers without page replay");
  for (const scenario of [
    { stage: "page", phase: "before", status: "RECOVERY_REQUIRED", calls: 1 },
    { stage: "page", phase: "after", status: "DONE", calls: 3 },
    { stage: "coverage", phase: "before", status: "RECOVERY_REQUIRED", calls: 3 },
    { stage: "coverage", phase: "after", status: "DONE", calls: 3 },
  ]) {
    const f = await seed(`${scenario.stage}_${scenario.phase}`), prior = reports.length;
    const persistence = repository().persistence, writer = persistence.saveExecutionCheckpoint.bind(persistence); let injected = false;
    persistence.saveExecutionCheckpoint = async checkpoint => {
      const execution = checkpoint.execution;
      if (!injected && checkpoint.executionId === f.id && (scenario.stage === "page" ? execution?.reportPageSecret?.["each/0/report"]?.pages.length === 1 : !!execution?.reportCoverages?.["each/0/report"])) {
        injected = true; if (scenario.phase === "after") await writer(checkpoint); throw new Error(`Synthetic protected report ${scenario.phase}-COMMIT ${scenario.stage} loss`);
      } return writer(checkpoint);
    };
    try { await assert.rejects(run(f)); assert(injected); assert.throws(() => repository().assertAuthority()); await assert.rejects(run(f)); }
    finally { persistence.saveExecutionCheckpoint = writer; }
    await repository().recoverPersistenceState(); stored = await saved(f);
    if (scenario.stage === "page") assert.equal(stored.reportPageSecret["each/0/report"].pages.length, scenario.phase === "after" ? 1 : 0);
    if (scenario.stage === "coverage") assert.equal(!!stored.reportCoverages?.["each/0/report"], scenario.phase === "after");
    await reopen(f); await waitFor(async () => (await saved(f)).protectedJobSecret.lease.expiresAt <= Date.now(), "protected report original lease expiry");
    result = await run(f); assert.equal(result.status, scenario.status); assert.equal(reports.length - prior, scenario.calls);
    if (scenario.status === "DONE") assert.deepEqual(result.finalOutput, [3]); else { assert.deepEqual(result.stepOutputs, {}); assert(!result.reportCoverages); }
    await reopen(f); assert.equal((await run(f)).status, scenario.status); assert.equal(reports.length - prior, scenario.calls);
    log(`actual Firestore protected report ${scenario.phase}-COMMIT ${scenario.stage} loss fenced authority; same-process reopen produced ${scenario.status} with ${scenario.calls} total SDK pages`);
  }
  assert.equal(reports.length - counts.reports, 16); assert.equal(calls.length, counts.calls); assert.equal(models.length, counts.models);
  assert.equal(operations.length, counts.operations); assert.equal(emails.length, counts.emails);
  console.log("Protected report qualification complete: actual local Firestore, synthetic governed SDK pages, exact-item coverage, four COMMIT-loss cases and same-process reopen. Public v9, report-error resolution, schedule composition, OS-process restart, live ERP/model/email and production acceptance remain unqualified.");
}

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { loadConfig } from "../src/config/config.js";
import { openApplicationRepository } from "../src/storage/open-repository.js";
import { ProtectedMachine, protectedMachinePlan } from "../src/workflows/protected-machine.js";
import { ProtectedInvocationLedger } from "../src/runner/protected-invocation-ledger.js";
import { ProtectedContinuationCodec } from "../src/runner/protected-continuation.js";
import { protectedJournalHash as hash } from "../src/repository/protected-invocation-records.js";
import { createProtectedApprovalRecord, decideProtectedApprovalRecord, consumeProtectedApprovalRecord } from "../src/runner/protected-approval-protocol.js";
import { assertProtectedApprovalRecords } from "../src/repository/protected-approval-records.js";
import { ProtectedJobCheckpoints } from "../src/runner/protected-job-checkpoints.js";
import { withoutSecretFields } from "../src/redact/secrets.js";
import { splitFirestoreState } from "../src/storage/firestore-record-layout.js";

// Actual encrypted application checkpoints for provisional DATA only.
// No human decision, admitted worker, model/ERP/email call or OS-process proof.
const projectId = "demo-lcwe-records";
if (process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:23671" || process.env.GCLOUD_PROJECT !== projectId || process.env.GOOGLE_APPLICATION_CREDENTIALS)
  throw new Error("Guarded fixed loopback demo emulator and no credential file are required");
const key = randomBytes(32).toString("base64"), config = loadConfig({ APP_ENV: "test", STORAGE_DRIVER: "firestore-records", FIRESTORE_PROJECT_ID: projectId,
  FIRESTORE_DATABASE_ID: "(default)", FIRESTORE_WORKSPACE_ID: `test_${randomUUID().replaceAll("-", "")}_approval`, STORAGE_ENCRYPTION_KEY: key,
  MCP_MODE: "mock", JWT_SECRET: "synthetic-approval-storage-secret-at-least-32" });
const codec = new ProtectedContinuationCodec(key);
let repository;
const reopen = async () => { await repository?.close(); repository = await openApplicationRepository(config); };
const log = value => console.log(`PASS: ${value}`);
function fixture(id) {
  const input = { id: "synthetic-private-approval-facts-only" }, inputs = { kind: "ref", source: "workflowInput", path: [] };
  const plan = protectedMachinePlan(`sha256:${"a".repeat(64)}`, { kind: "sequence", nodes: [{ kind: "action", nodeId: "send" }] }, [{ id: "send", input: inputs }]);
  const machine = new ProtectedMachine(plan, input); machine.peek();
  const identity = { executionId: id, workflowId: "fixture-flow", actorId: "owner", roleId: "requester", admittedRole: "Requester", sourceHash: plan.sourceHash,
    operationHash: `sha256:${"b".repeat(64)}`, machineHash: plan.semanticHash, inputHash: hash(input) };
  const ledger = new ProtectedInvocationLedger(identity, plan, machine), operationKey = ledger.prepare(machine, "effect", { kind: "node" }, input, 1);
  const contractHash = `sha256:${"c".repeat(64)}`, node = { id: "send", kind: "action", effectClass: "notification", inputs,
    capability: { toolId: "synthetic-send", action: "mail.send", remoteName: "mail.send__1.0.0", contractHash,
      admission: { connectionId: "fixture", capabilityId: "capability", revisionId: "revision", admissionVersion: 1, contractHash } } };
  const policy = { profile: "runtime-approval-policy/v1", enabled: true, revision: 1, ttlSeconds: 60, approverRoleIds: ["review"], separationOfDuties: true };
  const context = ledgerValue => ({ node, point: machine.peek(), ledger: ledgerValue, connectionBinding: "d".repeat(64), policy });
  const record = createProtectedApprovalRecord(context(ledger.snapshot()), `approval-${id}`, "Pure fixture review, no genuine human decision", 100000);
  const run = { id, workflowId: "fixture-flow", workflowName: "Provisional DATA storage fixture", status: "FIXTURE_APPROVAL_DATA", startedAt: new Date(100000).toISOString(),
    completedAt: null, durationMs: 0, costUsd: 0, tokens: { input: 0, output: 0, total: 0 }, startedBy: { id: "owner", name: "Owner" }, protectedInvocationSecret: ledger.snapshot(),
    protectedApprovalSecret: { profile: "protected-approvals/v1", count: 1, activeId: record.id, records: { [record.id]: record } } };
  const cursorIdentity = codec.identity({ executionId: id, workflowId: run.workflowId, epoch: 1, actorId: "owner", roleId: "requester", admittedRole: "Requester",
    sourceHash: plan.sourceHash, semanticHash: plan.semanticHash }, input);
  const evidence = saved => codec.evidenceBinding(cursorIdentity, { profile: "synthetic-protected-approval-evidence/v1",
    ledgerHash: hash(saved.protectedInvocationSecret), approvalHash: hash(saved.protectedApprovalSecret) });
  const seal = (state, saved, current = machine) => { assertProtectedApprovalRecords(saved.protectedApprovalSecret, saved.protectedInvocationSecret);
    state.protectedContinuations[id] = codec.encode(cursorIdentity, evidence(saved), current.snapshot()); };
  const transition = (state, stage) => {
    if (stage === "initialize") { state.executions[id] = structuredClone(run); seal(state, state.executions[id]); return; }
    const saved = state.executions[id], records = saved.protectedApprovalSecret, old = records.records[record.id];
    const restored = codec.decode(state.protectedContinuations[id], cursorIdentity, evidence(saved));
    const current = new ProtectedMachine(plan, {}, restored), journal = new ProtectedInvocationLedger(identity, plan, current, saved.protectedInvocationSecret);
    const actor = { id: "synthetic-reviewer", roleId: "review", active: true, permissions: ["execution:approve"] };
    if (stage === "decision") records.records[record.id] = decideProtectedApprovalRecord(context(journal.snapshot()), old,
      { approvalId: old.id, baseVersion: 1, reviewHash: old.reviewHash, decisionKey: "synthetic-original-decision-key-0001", note: "Provisional DATA only" }, actor, "APPROVED", 100001);
    if (stage === "consumption") {
      records.records[record.id] = consumeProtectedApprovalRecord(context(journal.snapshot()), old, actor, 100002);
      journal.dispatchIntent(current, operationKey, input, 1); saved.protectedInvocationSecret = journal.snapshot();
    }
    if (stage === "answer") {
      journal.acknowledgeOutput(current, operationKey, { accepted: true }, 1); const advanced = journal.advance(current, { kind: "accept", output: { accepted: true } });
      saved.protectedInvocationSecret = advanced.ledger; saved.status = "FIXTURE_ACKNOWLEDGED_DATA"; seal(state, saved, advanced.machine); return;
    }
    seal(state, saved, current);
  };
  const check = async () => {
    const state = await repository.snapshot(), saved = state.executions[id]; if (!saved) return null;
    assertProtectedApprovalRecords(saved.protectedApprovalSecret, saved.protectedInvocationSecret);
    const restored = codec.decode(state.protectedContinuations[id], cursorIdentity, evidence(saved));
    const newMachine = new ProtectedMachine(plan, {}, restored); new ProtectedInvocationLedger(identity, plan, newMachine, saved.protectedInvocationSecret);
    assert(!Object.hasOwn(withoutSecretFields(saved), "protectedApprovalSecret"));
    assert.equal(splitFirestoreState(state).filter(row => row.path[0] === "protected-approvals" && row.path[1] === id).length, 1);
    await assert.rejects(ProtectedJobCheckpoints.claim({ repository, config }, id), /admission is missing/);
    return saved;
  };
  return { id, transition, check };
}
try {
  await reopen(); const stages = ["initialize", "decision", "consumption", "answer"], successful = fixture("success");
  for (const stage of stages) { await repository.mutateExecution(successful.id, state => successful.transition(state, stage)); const saved = await successful.check();
    await reopen(); assert.deepEqual(await successful.check(), saved); }
  log("four actual encrypted approval DATA checkpoints/reopens retained exact records and cursor; missing admitted-job proof refused all worker claims");
  for (const stage of stages) for (const phase of ["before", "after"]) {
    const f = fixture(`${phase}-${stage}`); for (const preceding of stages.slice(0, stages.indexOf(stage))) await repository.mutateExecution(f.id, state => f.transition(state, preceding));
    const before = (await repository.snapshot()).executions[f.id] ?? null, persistence = repository.persistence, writer = persistence.saveExecutionCheckpoint.bind(persistence);
    persistence.saveExecutionCheckpoint = async checkpoint => { if (checkpoint.executionId === f.id) { if (phase === "after") await writer(checkpoint); throw new Error(`Synthetic approval ${phase}-COMMIT loss`); } return writer(checkpoint); };
    try { await assert.rejects(repository.mutateExecution(f.id, state => f.transition(state, stage))); assert.throws(() => repository.assertAuthority()); }
    finally { persistence.saveExecutionCheckpoint = writer; }
    await repository.recoverPersistenceState(); const reconciled = await f.check();
    if (phase === "before") assert.deepEqual(reconciled, before); else { assert(reconciled); assert.notDeepEqual(reconciled, before); }
    await reopen(); assert.deepEqual(await f.check(), reconciled);
    log(`actual approval DATA ${phase}-COMMIT ${stage} loss fenced old authority and reopened exactly ${phase === "before" ? "the preceding" : "one committed"} state without a worker or business call`);
  }
  console.log("Protected approval DATA storage qualification complete. Human review, waits, effect permits/drivers, live ERP/email, OS-process and production qualification remain pending.");
} finally { await repository?.close(); }

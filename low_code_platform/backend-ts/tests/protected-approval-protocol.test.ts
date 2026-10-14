import { expect, test } from "vitest";
import { ProtectedMachine, protectedMachinePlan } from "../src/workflows/protected-machine.js";
import { ProtectedInvocationLedger } from "../src/runner/protected-invocation-ledger.js";
import { protectedJournalHash as hash, assertProtectedInvocationExecution } from "../src/repository/protected-invocation-records.js";
import { createProtectedApprovalRecord, decideProtectedApprovalRecord, consumeProtectedApprovalRecord, expireProtectedApprovalRecord,
  type ProtectedApprovalContext, type ProtectedApproverData } from "../src/runner/protected-approval-protocol.js";
import { emptyProtectedApprovalRecords, assertProtectedApprovalRecords, protectedApprovalReviewHash, protectedApprovalDecisionFingerprint,
  type ProtectedApprovalRecord } from "../src/repository/protected-approval-records.js";
import { splitRuntimeState, assembleRuntimeState, checkpointRecords, executionRecordScope } from "../src/storage/execution-record-layout.js";
import { splitFirestoreState, assembleFirestoreState } from "../src/storage/firestore-record-layout.js";
import { initialState, type Execution } from "../src/repository/store.js";
import { ProtectedContinuationCodec } from "../src/runner/protected-continuation.js";
import { protectedEvidence } from "../src/runner/protected-job-state.js";
import { assertProtectedApprovalHistory } from "../src/runner/protected-approval-history.js";
import { withoutSecretFields } from "../src/redact/secrets.js";
import { canonicalJSONBytes } from "../src/core/canonical-json.js";

/** Pure provisional approval/effect DATA, not an admitted run, current human
 * decision, genuine broker dispatch, confirmed commit or delivery evidence. */
function fixture(nested = false) {
  const inputs: any = { kind: "object", fields: { id: nested ? { kind: "ref", source: "nodeOutput", nodeId: "each", path: ["item"] } :
    { kind: "ref", source: "workflowInput", path: ["id"] } } };
  const flow: any = { kind: "sequence", nodes: nested ? [{ kind: "foreach", id: "each", maxItems: 2,
    items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "workflowInput", path: ["items"] } },
    body: { kind: "sequence", nodes: [{ kind: "action", nodeId: "send" }] }, collect: { schema: { type: "boolean" }, value: { kind: "literal", value: true } } }] : [{ kind: "action", nodeId: "send" }] };
  const input = nested ? { items: ["A", "B"] } : { id: "A" }, plan = protectedMachinePlan(`sha256:${"a".repeat(64)}`, flow, [{ id: "send", input: inputs }]);
  const identity = { executionId: "run", workflowId: "flow", actorId: "owner", roleId: "requester-role", admittedRole: "Requester", sourceHash: plan.sourceHash,
    operationHash: `sha256:${"b".repeat(64)}`, machineHash: plan.semanticHash, inputHash: hash(input) };
  let machine = new ProtectedMachine(plan, input); machine.peek(); let ledger = new ProtectedInvocationLedger(identity, plan, machine);
  const toAction = () => { while (machine.peek()?.kind !== "action") {
    const point = machine.peek(); if (!point) throw new Error("Fixture exhausted");
    const typed = ["merge", "return", "collection-item"].includes(point.kind) || point.kind === "collection-complete" && point.outcome !== "FAILED" ||
      point.kind === "protected-complete" && ["SUCCEEDED", "HANDLED_ERROR"].includes(point.outcome!);
    const advanced = ledger.advance(machine, { kind: "accept", ...(typed ? { output: { value: point.value } } : {}) });
    machine = advanced.machine; ledger = new ProtectedInvocationLedger(identity, plan, machine, advanced.ledger);
  } };
  toAction();
  const contractHash = `sha256:${"c".repeat(64)}`, node: ProtectedApprovalContext["node"] = { id: "send", kind: "action", effectClass: "notification", inputs,
    capability: { toolId: "synthetic-send", action: "mail.send", remoteName: "mail.send__1.0.0", contractHash,
      admission: { connectionId: "fixture", capabilityId: "capability", revisionId: "revision", admissionVersion: 1, contractHash } } };
  const policy: ProtectedApprovalContext["policy"] = { profile: "runtime-approval-policy/v1", enabled: true, revision: 1, ttlSeconds: 60,
    approverRoleIds: ["review"], separationOfDuties: true };
  const prepare = () => ledger.prepare(machine, "effect", { kind: "node" }, machine.peek()!.arguments, 1);
  const key = prepare(), context = (): ProtectedApprovalContext => ({ node, point: machine.peek()!, ledger: ledger.snapshot(), connectionBinding: "d".repeat(64), policy });
  const record = createProtectedApprovalRecord(context(), "approval-A", "Review exact synthetic notification", 100000);
  const records = emptyProtectedApprovalRecords(); records.count = 1; records.activeId = record.id; records.records[record.id] = record;
  const actor: ProtectedApproverData = { id: "reviewer", roleId: "review", active: true, permissions: ["execution:approve"] };
  const command = (row = records.records[records.activeId!]!) => ({ approvalId: row.id, baseVersion: 1, reviewHash: row.reviewHash, decisionKey: "synthetic-decision-key-0001", note: "Reviewed exact facts" });
  const decide = (outcome: "APPROVED" | "REJECTED" = "APPROVED") => records.records[records.activeId!] = decideProtectedApprovalRecord(context(), records.records[records.activeId!]!, command(), actor, outcome, 100001);
  const consume = () => {
    const row = consumeProtectedApprovalRecord(context(), records.records[records.activeId!]!, actor, 100002);
    ledger.dispatchIntent(machine, row.binding.intentKey, machine.peek()!.arguments, ledger.snapshot().intents[row.binding.intentKey]!.epoch);
    records.records[records.activeId!] = row; assertProtectedApprovalRecords(records, ledger.snapshot()); return row;
  };
  const execution = (): Execution => ({ id: "run", workflowId: "flow", workflowName: "Pure DATA", status: "FIXTURE", startedAt: "now", completedAt: null,
    durationMs: 0, costUsd: 0, tokens: { input: 0, output: 0, total: 0 }, startedBy: { id: "owner", name: "Owner" },
    protectedInvocationSecret: ledger.snapshot(), protectedApprovalSecret: structuredClone(records) });
  const advance = () => { ledger.acknowledgeOutput(machine, records.records[records.activeId!]!.binding.intentKey, { accepted: true }, ledger.snapshot().intents[records.records[records.activeId!]!.binding.intentKey]!.epoch);
    const advanced = ledger.advance(machine, { kind: "accept", output: { accepted: true } }); machine = advanced.machine; ledger = new ProtectedInvocationLedger(identity, plan, machine, advanced.ledger); };
  return { plan, input, identity, node, policy, actor, key, record, records, context, command, decide, consume, execution, advance, toAction, prepare,
    ledger: () => ledger, machine: () => machine };
}

test("exact pure decision and consumption require matching dispatch intent; approval is never an SDK permit", () => {
  const f = fixture(); f.decide(); const before = f.ledger().snapshot();
  const provisional = consumeProtectedApprovalRecord(f.context(), f.records.records["approval-A"]!, f.actor, 100002);
  expect(() => assertProtectedApprovalRecords({ ...f.records, records: { "approval-A": provisional } }, before)).toThrow(/consumption/);
  f.consume(); f.advance(); expect(() => assertProtectedApprovalRecords(f.records, f.ledger().snapshot())).not.toThrow();
  expect(f.records.records["approval-A"]).toMatchObject({ state: "CONSUMED", version: 3, binding: { invocationId: "send" }, consumption: { epoch: 1 } });
});
test.each(["self", "inactive", "wrong-role", "missing-permission"])("%s approver DATA cannot decide or consume", damage => {
  const f = fixture(), invalid = { ...f.actor };
  if (damage === "self") invalid.id = "owner"; if (damage === "inactive") invalid.active = false;
  if (damage === "wrong-role") invalid.roleId = "other"; if (damage === "missing-permission") invalid.permissions = [];
  expect(() => decideProtectedApprovalRecord(f.context(), f.record, f.command(), invalid, "APPROVED", 100001)).toThrow(/independent/);
  f.decide(); expect(() => consumeProtectedApprovalRecord(f.context(), f.records.records["approval-A"]!, invalid, 100002)).toThrow(/independent/);
});
test.each(["argument", "node", "point", "policy", "pin", "connection", "readonly", "role", "expired", "backwards"])("changed %s cannot decide/consume an exact review", damage => {
  const f = fixture(), context = structuredClone(f.context()); f.decide();
  if (damage === "argument") (context.point.arguments as any).id = "B";
  if (damage === "node") context.node.capability.action = "other.send";
  if (damage === "point") context.point.value = "Foreign branch";
  if (damage === "policy") context.policy.revision++;
  if (damage === "pin") context.node.capability.admission!.admissionVersion++;
  if (damage === "connection") context.connectionBinding = "e".repeat(64);
  if (damage === "readonly") context.node.effectClass = "read";
  if (damage === "role") context.ledger.identity.roleId = "other";
  const now = damage === "expired" ? 160000 : damage === "backwards" ? 99999 : 100003;
  expect(() => consumeProtectedApprovalRecord(context, f.records.records["approval-A"]!, f.actor, now)).toThrow();
  expect(() => decideProtectedApprovalRecord(context, f.record, f.command(), f.actor, "APPROVED", now)).toThrow();
});
test.each(["id", "hash", "version", "key", "extra"])("invalid exact decision %s is refused", damage => {
  const f = fixture(), command: any = f.command();
  if (damage === "id") command.approvalId = "other"; if (damage === "hash") command.reviewHash = `sha256:${"e".repeat(64)}`;
  if (damage === "version") command.baseVersion = 2; if (damage === "key") command.decisionKey = "short"; if (damage === "extra") command.permit = true;
  expect(() => decideProtectedApprovalRecord(f.context(), f.record, command, f.actor, "APPROVED", 100001)).toThrow();
});
test("original-key decision replay remains historical after consumption/expiry and cannot renew or consume twice", () => {
  const f = fixture(); f.decide(); f.consume();
  const record = f.records.records["approval-A"]!, replay = decideProtectedApprovalRecord(f.context(), record, f.command(), f.actor, "APPROVED", 200000);
  expect(replay).toEqual(record); expect(replay.expiresAt).toBe(f.record.expiresAt);
  expect(() => consumeProtectedApprovalRecord(f.context(), record, f.actor, 100004)).toThrow();
  expect(() => decideProtectedApprovalRecord(f.context(), record, { ...f.command(), note: "Changed" }, f.actor, "APPROVED", 100004)).toThrow();
  expect(() => decideProtectedApprovalRecord(f.context(), record, f.command(), f.actor, "REJECTED", 100004)).toThrow();
});
test("never-entered epoch transfer preserves approval facts and deadline, with consumption bound to the new claim", () => {
  const f = fixture(); f.decide(); f.ledger().transferPrepared(f.machine(), f.key, 2); f.consume();
  expect(f.records.records["approval-A"]).toMatchObject({ binding: { requestEpoch: 1 }, consumption: { epoch: 2 }, expiresAt: f.record.expiresAt });
});
test.each(["PENDING", "APPROVED"])("%s expires at its original deadline without dispatch", state => {
  const f = fixture(); if (state === "APPROVED") f.decide();
  const before = f.records.records["approval-A"]!;
  expect(() => expireProtectedApprovalRecord(before, f.ledger().snapshot(), 159999)).toThrow();
  f.records.records["approval-A"] = expireProtectedApprovalRecord(before, f.ledger().snapshot(), 160000);
  expect(() => assertProtectedApprovalRecords(f.records, f.ledger().snapshot())).not.toThrow();
  expect(() => consumeProtectedApprovalRecord(f.context(), f.records.records["approval-A"]!, f.actor, 160000)).toThrow();
  expect(f.ledger().snapshot().intents[f.key]!.state).toBe("PREPARING");
});
test("rejection cannot become consumption, expiry or a successful original effect", () => {
  const f = fixture(); f.decide("REJECTED"); expect(() => assertProtectedApprovalRecords(f.records, f.ledger().snapshot())).not.toThrow();
  expect(() => consumeProtectedApprovalRecord(f.context(), f.records.records["approval-A"]!, f.actor, 100004)).toThrow();
  expect(() => expireProtectedApprovalRecord(f.records.records["approval-A"]!, f.ledger().snapshot(), 160000)).toThrow();
});
test("nested sibling items require separate exact approvals even when tool/content are similar", () => {
  const f = fixture(true), original = f.context(); f.decide(); f.consume(); f.advance(); f.toAction(); f.prepare();
  const next = createProtectedApprovalRecord(f.context(), "approval-B", "Review next exact item", 100100);
  expect(next.binding.invocationId).toBe("each/1/send"); expect(f.record.binding.invocationId).toBe("each/0/send");
  expect(() => decideProtectedApprovalRecord(f.context(), f.record, f.command(f.record), f.actor, "APPROVED", 100101)).toThrow();
  expect(() => decideProtectedApprovalRecord({ ...original, ledger: f.ledger().snapshot() }, f.records.records["approval-A"]!, f.command(f.record), f.actor, "APPROVED", 100101)).not.toThrow();
  f.records.records[next.id] = next; f.records.activeId = next.id; f.records.count++;
  expect(() => assertProtectedApprovalRecords(f.records, f.ledger().snapshot())).not.toThrow();
});
test.each(["self", "role", "count", "active", "missing", "extra", "version", "expiry", "epoch", "argument"])("damaged %s records fail closed", damage => {
  const f = fixture(); f.decide(); const row = f.records.records["approval-A"]!;
  if (damage === "self") row.decision!.actorId = "owner"; if (damage === "role") row.decision!.roleId = "other";
  if (damage === "count") f.records.count++; if (damage === "active") f.records.activeId = "missing"; if (damage === "missing") delete f.records.records["approval-A"];
  if (damage === "extra") (f.records as any).permit = true; if (damage === "version") row.version++;
  if (damage === "expiry") { row.expiresAt = new Date(161000).toISOString(); row.reviewHash = protectedApprovalReviewHash(row); }
  if (damage === "epoch") row.binding.requestEpoch = 2; if (damage === "argument") row.arguments.id = "B";
  expect(() => assertProtectedApprovalRecords(f.records, f.ledger().snapshot())).toThrow();
});
test.each(["secret", "nonfinite", "oversize", "entered"])("%s preparation cannot create a reviewable approval", damage => {
  const f = fixture(), context = f.context();
  if (damage === "secret") (context.point.arguments as any).api_key = "private";
  if (damage === "nonfinite") (context.point.arguments as any).id = Infinity;
  if (damage === "oversize") (context.point.arguments as any).id = "x".repeat(65000);
  if (damage === "entered") { f.ledger().dispatchIntent(f.machine(), f.key, f.context().point.arguments, 1); context.ledger = f.ledger().snapshot(); }
  expect(() => createProtectedApprovalRecord(context, "approval-B", "Invalid review", 100001)).toThrow();
});
test("complete normalized approval leaves roundtrip canonically, stay scoped/private and omit embedded duplicates", () => {
  const f = fixture(); f.decide(); const state = initialState(); state.executions.run = f.execution();
  for (const [split, assemble] of [[splitRuntimeState, assembleRuntimeState], [splitFirestoreState, assembleFirestoreState]] as const) {
    const records = JSON.parse(canonicalJSONBytes(split(state)).toString("utf8")); expect(assemble(records)).toEqual(state);
    const leaves = records.filter((row: any) => row.path[0] === "protected-approvals"); expect(leaves).toHaveLength(1);
    expect(executionRecordScope(leaves[0])).toBe("run");
    expect(records.find((row: any) => row.path[0] === "executions").value.protectedApprovalSecret.records).toEqual({});
  }
  expect(withoutSecretFields(f.execution())).not.toHaveProperty("protectedApprovalSecret");
  expect(checkpointRecords({ executionId: "run", execution: f.execution(), auditStart: 0, auditAppend: [] }).some(row => row.path[0] === "protected-approvals")).toBe(true);
});
test.each(["missing", "duplicate", "embedded", "orphan", "legacy"])("normalized %s ownership cannot be silently accepted", damage => {
  const f = fixture(), state = initialState(); state.executions.run = f.execution(); let records = splitRuntimeState(state);
  if (damage === "missing") records = records.filter(row => row.path[0] !== "protected-approvals");
  if (damage === "duplicate") records.push(records.find(row => row.path[0] === "protected-approvals")!);
  if (damage === "embedded") (records.find(row => row.path[0] === "executions")!.value as Execution).protectedApprovalSecret!.records = f.records.records;
  if (damage === "orphan") records = records.filter(row => row.path[0] !== "executions");
  if (damage === "legacy") (records.find(row => row.path[0] === "executions")!.value as Execution).runtimeApprovalSecret = {} as never;
  expect(() => assembleRuntimeState(records)).toThrow();
});
test("approval artifacts require their ledger and bind the authenticated private cursor; absence retains old evidence", () => {
  const f = fixture(), run = f.execution();
  const orphan = structuredClone(run); delete orphan.protectedInvocationSecret; expect(() => assertProtectedInvocationExecution(orphan)).toThrow(/Orphan/);
  run.protectedJobSecret = { admissionSeal: "a".repeat(64) } as never;
  const codec = new ProtectedContinuationCodec("synthetic-server-key-at-least-32-bytes"), identity = codec.identity({ executionId: "run", workflowId: "flow", epoch: 1,
    actorId: "owner", roleId: "requester-role", admittedRole: "Requester", sourceHash: f.plan.sourceHash, semanticHash: f.plan.semanticHash }, f.input);
  const sealed = codec.encode(identity, codec.evidenceBinding(identity, protectedEvidence(run)), f.machine().snapshot());
  run.protectedApprovalSecret!.records["approval-A"]!.reason = "Changed exact review";
  run.protectedApprovalSecret!.records["approval-A"]!.reviewHash = protectedApprovalReviewHash(run.protectedApprovalSecret!.records["approval-A"]!);
  expect(() => codec.decode(sealed, identity, codec.evidenceBinding(identity, protectedEvidence(run)))).toThrow();
  delete run.protectedApprovalSecret; expect(protectedEvidence(run)).toEqual({ profile: "owned-protected-job-evidence/v1", admissionSeal: "a".repeat(64), ledgerHash: hash(run.protectedInvocationSecret) });
});
test("historical semantic replay rejects a rehashed foreign point/node, not just malformed hashes", () => {
  const f = fixture(), run = f.execution(); run.workflowSnapshot = { input: f.input } as never;
  const plan = { machine: f.plan, ir: { root: { nodes: [f.node] }, contracts: {} } } as never;
  expect(() => assertProtectedApprovalHistory(plan, run)).not.toThrow();
  const row = run.protectedApprovalSecret!.records["approval-A"]!; row.binding.pointHash = `sha256:${"e".repeat(64)}`; row.reviewHash = protectedApprovalReviewHash(row);
  expect(() => assertProtectedApprovalRecords(run.protectedApprovalSecret, run.protectedInvocationSecret!)).not.toThrow();
  expect(() => assertProtectedApprovalHistory(plan, run)).toThrow(/original exact item/);
});

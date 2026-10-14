import jwt from "jsonwebtoken";
import { afterEach, expect, test, vi } from "vitest";
import { protectedPreparationFixture as fixture } from "./fixtures/protected-preparation.js";
import { fixtureSequence as seq, fixtureAction as action, fixtureRef as ref } from "./fixtures/protected-simulation.js";
import { publishProtectedOperation, assertStoredProtectedOperationPublicationCurrent,
  type ProtectedOperationPublicationReceipt } from "../src/workflows/protected-operation-publication.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import { ProtectedMachine } from "../src/workflows/protected-machine.js";
import { ProtectedInvocationLedger } from "../src/runner/protected-invocation-ledger.js";
import { admitProtectedOperation } from "../src/runner/protected-job-admission.js";
import { newReadProgress } from "../src/runner/read-checkpoints.js";
import { protectedAdmissionSeal, protectedHash as hash, restoreProtectedJob, sealProtectedCursor,
  type ProtectedJobOwner } from "../src/runner/protected-job-state.js";
import { createOwnedProtectedApprovalWait, maintainProtectedApprovalWaits } from "../src/runner/protected-approval-wait.js";
import { decideOwnedProtectedApproval, protectedApprovalView } from "../src/runner/protected-approval-review.js";
import { closeProtectedApprovalRecord, consumeProtectedApprovalRecord, decideProtectedApprovalRecord } from "../src/runner/protected-approval-protocol.js";
import { currentProtectedApprovalContext } from "../src/runner/protected-approval-context.js";
import { assertProtectedApprovalRecords, protectedApprovalReviewHash } from "../src/repository/protected-approval-records.js";
import type { Execution, RepositoryState } from "../src/repository/store.js";

vi.setConfig({ testTimeout: 15_000 });
const closers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => { for (const value of closers.splice(0).reverse()) await value.close(); vi.restoreAllMocks(); });
const runId = "synthetic-private-owned-approval-run", requestKey = "synthetic-owned-effect-admission-0001";
const owner: ProtectedJobOwner = { workerId: "synthetic-worker", leaseId: "synthetic-private-lease", epoch: 1 };

/** Real session, reviews, immutable publication and signed reviewer HTTP.
 * The private CLAIMED job below is explicitly test-only synthetic data: normal
 * effect admission remains denied and no live SDK/effect success is claimed. */
async function setup(readonly = false) {
  const s = await fixture("effect"); closers.push(s);
  const nodeId = readonly ? "lookup" : "send", tool = s.tools[readonly ? 0 : 1]!;
  s.source.steps = [{ id: nodeId, action: tool.name, parameters: { id: "{{each.item}}" } }];
  const outputSchema = readonly ? { type: "string" } : { type: "boolean" };
  s.source.metadata.controlFlow.root = seq({ kind: "foreach", id: "each", maxItems: 3,
    items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "workflowInput", path: ["items"] } },
    body: seq(action(nodeId)), collect: { schema: outputSchema, value: ref(nodeId, "structuredContent", readonly ? "text" : "accepted") } },
    { kind: "return", id: "answer", output: { schema: { type: "array", items: outputSchema }, value: ref("each", "value") } });
  await s.saveSource();
  await s.repository.mutate(state => {
    const now = new Date().toISOString(), template = state.users.requester!;
    state.roles.other = { id: "other", name: "Other reviewer role", description: "Excluded by policy", permissions: ["execution:approve"], createdAt: now };
    state.users.reviewer = { ...template, id: "reviewer", name: "Independent reviewer", email: "reviewer@example.test", roleId: "review" };
    state.users.reviewer2 = { ...template, id: "reviewer2", name: "Second reviewer", email: "reviewer2@example.test", roleId: "review" };
    state.users.foreign = { ...template, id: "foreign", name: "Foreign reviewer", email: "foreign@example.test", roleId: "other" };
    state.users.inactive = { ...template, id: "inactive", name: "Inactive reviewer", email: "inactive@example.test", roleId: "review", status: "Suspended" };
  });
  const base = await s.repository.readAuthoritative(state => ({ baseVersion: state.workflows.flow!.draftVersion,
    baseHash: workflowContentHash(state.workflows.flow!.yaml) }));
  const publication = await publishProtectedOperation(s.services, "flow", s.actor, base);
  const seedClaim = async () => s.repository.mutate(state => {
    const stored = state.versions.flow!.find(version => version.id === publication.id)!;
    const plan = assertStoredProtectedOperationPublicationCurrent(state, s.services, String(stored.id), "flow", s.actor.role);
    const input = { items: ["private-item-A", "private-item-B"] }, createdAt = new Date().toISOString();
    let machine = new ProtectedMachine(plan.machine, input); machine.peek();
    const identity = { executionId: runId, workflowId: "flow", actorId: s.actor.id, roleId: s.actor.roleId,
      admittedRole: s.actor.role, sourceHash: plan.sourceHash, operationHash: plan.semanticHash, machineHash: plan.machine.semanticHash, inputHash: hash(input) };
    let ledger = new ProtectedInvocationLedger(identity, plan.machine, machine);
    // Structural collection boundaries are pure receipts, with no read prefix,
    // synthetic tool acknowledgement or legacy operation/read attempt fields.
    while (machine.peek()?.kind !== "action") {
      const point = machine.peek(); if (!point) throw new Error("Synthetic fixture has no effect");
      const typed = ["merge", "return", "collection-item"].includes(point.kind) ||
        point.kind === "collection-complete" && point.outcome !== "FAILED";
      const next = ledger.advance(machine, { kind: "accept", ...(typed ? { output: { value: point.value } } : {}) });
      machine = next.machine; ledger = new ProtectedInvocationLedger(identity, plan.machine, machine, next.ledger);
    }
    const receipt = structuredClone(stored.protectedCompilation) as ProtectedOperationPublicationReceipt;
    const run: Execution = { id: runId, workflowId: "flow", workflowName: "Synthetic private approval fixture",
      status: "RUNNING", startedBy: { id: s.actor.id, name: s.actor.name }, startedAt: createdAt, completedAt: null,
      durationMs: 0, costUsd: 0, tokens: { input: 0, output: 0, total: 0 }, stepOutputs: {}, readProgress: newReadProgress(s.repository),
      workflowSnapshot: { yaml: stored.yaml as string, version: receipt.version, contentHash: plan.sourceHash,
        registryHash: receipt.registryHash, input, executionProfile: "protected-operation-v1", protectedCompilation: receipt },
      protectedInvocationSecret: ledger.snapshot(), protectedJobSecret: { profile: "protected-operation-job/v1", actorId: s.actor.id,
        roleId: s.actor.roleId, admittedRole: s.actor.role, departmentId: s.actor.departmentId,
        permissionsHash: hash([...new Set(s.actor.permissions)].sort()), publicationId: String(stored.id),
        idempotencyScope: hash(["synthetic-test-only", requestKey]), requestFingerprint: hash({ workflowId: "flow", input }),
        createdAt, state: "CLAIMED", admissionSeal: "0".repeat(64), lease: { id: owner.leaseId, workerId: owner.workerId, expiresAt: Date.now() + 60_000 } } };
    run.protectedJobSecret!.admissionSeal = protectedAdmissionSeal(s.services, run);
    state.executions[runId] = run; state.timelines[runId] = []; state.executionLogs[runId] = []; state.executionEvents[runId] = [];
    sealProtectedCursor(s.services, state, run, machine);
  });
  const as = (userId: string, method: "GET" | "POST", url: string, payload?: unknown, claims: object = {}) => s.app.inject({ method, url,
    headers: { authorization: `Bearer ${jwt.sign(claims, s.config.jwtSecret, { subject: userId, expiresIn: 3600 })}` },
    ...(payload === undefined ? {} : { payload: payload as object }) });
  const wait = () => s.repository.mutateExecution(runId, state => createOwnedProtectedApprovalWait(state, s.services, runId, owner));
  const view = (userId = "reviewer", id?: string) => as(userId, "GET", `/api/executions/${runId}?view=approval${id ? `&approvalId=${id}` : ""}`);
  const record = async () => s.repository.readAuthoritative(state => {
    const journal = state.executions[runId]!.protectedApprovalSecret!; return structuredClone(journal.records[journal.activeId!]!);
  });
  const command = async () => { const row = await record(); return { approvalId: row.id, baseVersion: 1,
    reviewHash: row.reviewHash, decisionKey: "synthetic-http-review-key-0001", note: "Reviewed the exact first collection item" }; };
  const decide = async (outcome = "approve", userId = "reviewer", body?: unknown) => as(userId, "POST",
    `/api/executions/${runId}/${outcome}`, body === undefined ? await command() : body);
  const noCalls = () => { expect(s.sdk.callTool).not.toHaveBeenCalled(); expect(s.modelFetch).not.toHaveBeenCalled(); };
  return { ...s, publication, seedClaim, as, wait, view, record, command, decide, noCalls };
}
type Setup = Awaited<ReturnType<typeof setup>>;
async function waiting() { const s = await setup(); await s.seedClaim(); await s.wait(); return s; }
const stateRun = (state: RepositoryState) => state.executions[runId]!;

test("owned atomic wait captures exact item, current policy/session, private journal and cursor and releases the lease", async () => {
  const s = await setup(); await s.seedClaim(); const before = await s.repository.snapshot(), id = await s.wait(), state = await s.repository.snapshot();
  const run = stateRun(state), row = await s.record(), restored = restoreProtectedJob(state, s.services, runId);
  expect(run).toMatchObject({ status: "AWAITING_APPROVAL", completedAt: null, protectedJobSecret: { state: "WAITING" },
    pendingApproval: { stepId: "send", invocationId: "each/0/send", iterations: [{ loopId: "each", index: 0 }] } });
  expect(run.protectedJobSecret).not.toHaveProperty("lease"); expect(run).not.toHaveProperty("operationSecret");
  expect(run.readProgress!.attempts).toEqual({}); expect(restored.machine.peek()).toMatchObject({ nodeId: "send", invocationId: "each/0/send", arguments: { id: "private-item-A" } });
  expect(row).toMatchObject({ id, version: 1, state: "PENDING", arguments: { id: "private-item-A" },
    binding: { executionId: runId, workflowId: "flow", requesterId: "requester", requestEpoch: owner.epoch,
      nodeId: "send", invocationId: "each/0/send", iterations: [{ loopId: "each", index: 0 }], connectionBinding: s.session.admissionBinding } });
  expect(row.policy).toEqual((state.settings.rbac as any).runtimeApprovalPolicy);
  expect(Date.parse(row.expiresAt) - Date.parse(row.requestedAt)).toBe(row.policy.ttlSeconds * 1000);
  expect(run.protectedInvocationSecret!.intents[row.binding.intentKey]).toMatchObject({ state: "PREPARING", purpose: "effect", epoch: owner.epoch });
  expect(state.protectedContinuations[runId]).not.toEqual(before.protectedContinuations[runId]);
  expect(state.executionEvents[runId]).toHaveLength(1); expect(state.executionEvents[runId]![0]).toMatchObject({ type: "approval.requested", nodeId: "send", attemptId: "each/0/send" });
  expect(state.timelines[runId]).toHaveLength(1); expect(state.timelines[runId]![0]).toMatchObject({ approvalId: id, invocationId: "each/0/send" }); s.noCalls();
});

test.each(["worker", "lease", "epoch", "expired-lease"])("wrong %s cannot request an owned wait or write partial approval evidence", async damage => {
  const s = await setup(); await s.seedClaim(); const invalid = { ...owner };
  if (damage === "worker") invalid.workerId = "foreign-worker"; if (damage === "lease") invalid.leaseId = "foreign-lease";
  if (damage === "epoch") invalid.epoch++;
  if (damage === "expired-lease") await s.repository.mutate(state => { stateRun(state).protectedJobSecret!.lease!.expiresAt = Date.now() - 1; });
  const before = await s.repository.snapshot();
  await expect(s.repository.mutateExecution(runId, state => createOwnedProtectedApprovalWait(state, s.services, runId, invalid))).rejects.toThrow(/ownership/);
  expect(await s.repository.snapshot()).toEqual(before); s.noCalls();
});

test("read-only current invocation cannot request an effect approval", async () => {
  const s = await setup(true); await s.seedClaim(); const before = await s.repository.snapshot();
  await expect(s.wait()).rejects.toThrow(/governed effect/); expect(await s.repository.snapshot()).toEqual(before); s.noCalls();
});

test.each(["entered", "foreign-epoch", "read-purpose"])("%s pending intent cannot become an owned review", async damage => {
  const s = await setup(); await s.seedClaim();
  await s.repository.mutateExecution(runId, state => {
    const saved = restoreProtectedJob(state, s.services, runId), point = saved.machine.peek()!;
    const key = saved.ledger.prepare(saved.machine, damage === "read-purpose" ? "read" : "effect", { kind: "node" }, point.arguments,
      damage === "foreign-epoch" ? owner.epoch + 1 : owner.epoch);
    if (damage === "entered") saved.ledger.dispatchIntent(saved.machine, key, point.arguments, owner.epoch);
    saved.run.protectedInvocationSecret = saved.ledger.snapshot(); sealProtectedCursor(s.services, state, saved.run, saved.machine);
  });
  const before = await s.repository.snapshot(); await expect(s.wait()).rejects.toThrow(/entered or foreign/);
  expect(await s.repository.snapshot()).toEqual(before); s.noCalls();
});

test("duplicate owned request cannot replace review identity or renew original deadline", async () => {
  const s = await waiting(), before = await s.repository.snapshot(), original = await s.record();
  await expect(s.wait()).rejects.toThrow(); expect(await s.record()).toEqual(original); expect(await s.repository.snapshot()).toEqual(before); s.noCalls();
});

test("signed independent reviewer sees exact tuple and HTTP approval records BLOCKED WAITING with no resume or SDK entry", async () => {
  const s = await waiting(), row = await s.record(), response = await s.view();
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.runtimeApproval).toMatchObject({ id: row.id, state: "PENDING", version: 1, reviewHash: row.reviewHash,
    nodeId: "send", invocationId: "each/0/send", iterations: [{ loopId: "each", index: 0 }], arguments: { id: "private-item-A" },
    canDecide: true, canResume: false, resumeQueued: false, protectedInvocationManaged: true, operationManaged: false });
  expect(response.body).not.toMatch(/protectedApprovalSecret|protectedInvocationSecret|admissionSeal|intentKey|connectionBinding|ciphertext|private-synthetic-token/);
  const before = await s.repository.snapshot(), approved = await s.decide(); expect(approved.statusCode, approved.body).toBe(200);
  expect(approved.json().data).toMatchObject({ replayed: false, state: "APPROVED", version: 2, executionStatus: "BLOCKED", canResume: false, resumeQueued: false });
  const state = await s.repository.snapshot(), run = stateRun(state), decision = await s.record();
  expect(run).toMatchObject({ status: "BLOCKED", completedAt: null, protectedJobSecret: { state: "WAITING" } });
  expect(run).not.toHaveProperty("pendingApproval"); expect(run.protectedJobSecret).not.toHaveProperty("lease");
  expect(decision.decision).toMatchObject({ actorId: "reviewer", roleId: "review", outcome: "APPROVED" });
  expect(decision.expiresAt).toBe(row.expiresAt); expect(run.protectedInvocationSecret).toEqual(stateRun(before).protectedInvocationSecret);
  expect(state.protectedContinuations[runId]).not.toEqual(before.protectedContinuations[runId]);
  expect(restoreProtectedJob(state, s.services, runId).machine.peek()!.invocationId).toBe("each/0/send");
  expect(state.executionEvents[runId]!.map(event => event.type)).toEqual(["approval.requested", "approval.granted"]);
  expect((await s.view()).json().data.runtimeApproval).toMatchObject({ state: "APPROVED", canDecide: false, canResume: false }); s.noCalls();
});

test.each(["self", "inactive", "wrong-role", "missing-permission", "missing-account"])("%s actor cannot review or decide through signed HTTP", async damage => {
  const s = await waiting(); let userId = "reviewer";
  if (damage === "self") userId = "requester"; if (damage === "inactive") userId = "inactive"; if (damage === "wrong-role") userId = "foreign";
  if (damage === "missing-account") userId = "does-not-exist";
  if (damage === "missing-permission") await s.repository.mutate(state => { state.roles.review!.permissions = []; });
  const before = await s.repository.snapshot(); const review = await s.view(userId), decision = await s.decide("approve", userId);
  expect([401, 403]).toContain(review.statusCode); expect([401, 403]).toContain(decision.statusCode);
  expect(await s.repository.snapshot()).toEqual(before); s.noCalls();
});

test("request/JWT role and user claims cannot forge current reviewer identity", async () => {
  const s = await waiting(), command = await s.command(), before = await s.repository.snapshot();
  const forged = await s.as("foreign", "POST", `/api/executions/${runId}/approve`, command,
    { id: "reviewer", userId: "reviewer", roleId: "review", role: "Independent approver", permissions: ["execution:approve"], active: true });
  expect(forged.statusCode, forged.body).toBe(403);
  const actor = (await s.repository.effectiveUser("reviewer"))!;
  await expect(decideOwnedProtectedApproval(s.services, runId, { ...actor, permissions: [...actor.permissions, "forged:authority"] }, command, "APPROVED"))
    .rejects.toThrow(/authority/);
  expect(await s.repository.snapshot()).toEqual(before); s.noCalls();
});

test.each(["missing", "malformed", "version", "hash", "id", "key", "extra", "actor"])("%s exact HTTP decision command is refused without journal mutation", async damage => {
  const s = await waiting(), original = await s.command(), body: any = { ...original };
  if (damage === "missing") delete body.reviewHash; if (damage === "malformed") body.baseVersion = "1";
  if (damage === "version") body.baseVersion = 2; if (damage === "hash") body.reviewHash = `sha256:${"f".repeat(64)}`;
  if (damage === "id") body.approvalId = "foreign-review"; if (damage === "key") body.decisionKey = "short";
  if (damage === "extra") body.permit = true; if (damage === "actor") body.actorId = "reviewer2";
  const before = await s.repository.snapshot(), response = await s.decide("approve", "reviewer", body);
  expect([409, 422]).toContain(response.statusCode); expect(await s.repository.snapshot()).toEqual(before); s.noCalls();
});

test("exact historical approve replay is idempotent; changed note/key/outcome/reviewer conflicts", async () => {
  const s = await waiting(), command = await s.command(); expect((await s.decide("approve", "reviewer", command)).statusCode).toBe(200);
  const before = await s.repository.snapshot(), replay = await s.decide("approve", "reviewer", command);
  expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().data).toMatchObject({ replayed: true, state: "APPROVED", canResume: false, resumeQueued: false });
  for (const [outcome, reviewer, body] of [["approve", "reviewer", { ...command, note: "Changed note" }],
    ["approve", "reviewer", { ...command, decisionKey: "synthetic-other-decision-0001" }], ["reject", "reviewer", command],
    ["approve", "reviewer2", command]] as const) {
    const rejected = await s.decide(outcome, reviewer, body); expect(rejected.statusCode, rejected.body).toBe(409);
  }
  expect(await s.repository.snapshot()).toEqual(before); s.noCalls();
});

test("HTTP rejection closes terminally and exact rejected replay does not dispatch or append events", async () => {
  const s = await waiting(), command = await s.command(), response = await s.decide("reject", "reviewer", command);
  expect(response.statusCode, response.body).toBe(200); expect(response.json().data).toMatchObject({ state: "REJECTED", executionStatus: "FAILED", resumeQueued: false });
  const state = await s.repository.snapshot(), run = stateRun(state);
  expect(run).toMatchObject({ status: "FAILED", protectedJobSecret: { state: "FINISHED" }, failure: { failureCategory: "PROTECTED_APPROVAL_REJECTED", toolWasCalled: false } });
  expect(run.completedAt).not.toBeNull(); expect(run).not.toHaveProperty("pendingApproval");
  expect((await s.record()).closure).toBeUndefined(); expect(restoreProtectedJob(state, s.services, runId).machine.peek()!.invocationId).toBe("each/0/send");
  expect((await s.decide("reject", "reviewer", command)).json().data.replayed).toBe(true);
  expect((await s.decide("approve", "reviewer", command)).statusCode).toBe(409);
  expect(await s.repository.snapshot()).toEqual(state); s.noCalls();
});

test.each(["policy", "connection", "publication", "authored-workflow", "requester", "cancellation"])("changed current %s refuses decisions and presents unavailable review", async damage => {
  const s = await waiting(), command = await s.command();
  await s.repository.mutate(state => {
    if (damage === "policy") (state.settings.rbac as any).runtimeApprovalPolicy.revision++;
    if (damage === "publication") state.workflows.flow!.publishedVersion++;
    if (damage === "authored-workflow") state.workflows.flow!.yaml = state.workflows.flow!.yaml.replace("hr.notify", "hr.changed");
    if (damage === "requester") state.users.requester!.status = "Suspended";
    if (damage === "cancellation") stateRun(state).readProgress!.cancellation = { requestedAt: new Date().toISOString(), requestedBy: { id: "requester", name: "requester" } };
  });
  if (damage === "connection") s.services.erpbridgeSession = undefined;
  const before = await s.repository.snapshot(), response = await s.decide("approve", "reviewer", command);
  expect([409, 503]).toContain(response.statusCode); const review = await s.view();
  expect(review.statusCode, review.body).toBe(200); expect(review.json().data.runtimeApproval).toMatchObject({ canDecide: false, canResume: false });
  expect(review.json().data.runtimeApproval.unavailable).toBeTruthy(); expect(await s.repository.snapshot()).toEqual(before); s.noCalls();
});

test.each([false, true])("%s approved original TTL expires by maintenance without entering a call", async approved => {
  const s = await waiting(), command = await s.command(); if (approved) expect((await s.decide("approve", "reviewer", command)).statusCode).toBe(200);
  const original = await s.record(); vi.spyOn(Date, "now").mockReturnValue(Date.parse(original.expiresAt));
  expect((await s.decide("approve", "reviewer2")).statusCode).toBe(409);
  expect(await maintainProtectedApprovalWaits(s.services)).toBe(1); expect(await maintainProtectedApprovalWaits(s.services)).toBe(0);
  const state = await s.repository.snapshot(), row = await s.record(); expect(row).toMatchObject({ state: "EXPIRED", version: approved ? 3 : 2, expiresAt: original.expiresAt });
  expect(stateRun(state)).toMatchObject({ status: "FAILED", protectedJobSecret: { state: "FINISHED" }, failure: { failureCategory: "PROTECTED_APPROVAL_EXPIRED", toolWasCalled: false } });
  expect(() => restoreProtectedJob(state, s.services, runId)).not.toThrow();
  if (approved) { const replay = await s.decide("approve", "reviewer", command); expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().data).toMatchObject({ state: "EXPIRED", replayed: true, canResume: false }); }
  s.noCalls();
});

test.each([false, true])("%s approved cancellation maintenance commits CLOSED private evidence", async approved => {
  const s = await waiting(); if (approved) expect((await s.decide()).statusCode).toBe(200);
  await s.repository.mutate(state => { stateRun(state).readProgress!.cancellation = { requestedAt: new Date().toISOString(), requestedBy: { id: "requester", name: "requester" } }; });
  expect(await maintainProtectedApprovalWaits(s.services)).toBe(1); const state = await s.repository.snapshot(), row = await s.record();
  expect(row).toMatchObject({ state: "CLOSED", version: approved ? 3 : 2, closure: { reason: "PROTECTED_APPROVAL_CANCELLED", status: "CANCELLED" } });
  expect(stateRun(state)).toMatchObject({ status: "CANCELLED", protectedJobSecret: { state: "FINISHED" } }); expect(() => restoreProtectedJob(state, s.services, runId)).not.toThrow(); s.noCalls();
});

test.each([false, true])("public HTTP cancel closes %s approved wait and preserves exact journal and cursor", async approved => {
  const s = await waiting(); if (approved) expect((await s.decide()).statusCode).toBe(200);
  const cancelled = await s.as("requester", "POST", `/api/executions/${runId}/cancel`, {}); expect(cancelled.statusCode, cancelled.body).toBe(200);
  expect(cancelled.json().data).toMatchObject({ status: "CANCELLED" }); expect(cancelled.body).not.toMatch(/protectedApprovalSecret|protectedInvocationSecret|ciphertext|private-synthetic-token/);
  const state = await s.repository.snapshot(); expect((await s.record()).state).toBe("CLOSED"); expect(() => restoreProtectedJob(state, s.services, runId)).not.toThrow();
  expect((await s.decide()).statusCode).toBe(409); expect((await s.as("requester", "POST", `/api/executions/${runId}/cancel`, {})).statusCode).toBe(200); s.noCalls();
});

test.each(["cancel-pending", "cancel-approved", "context-pending", "context-approved"])("%s cannot resurrect through public lifecycle fields with original journal/cursor", async damage => {
  const s = await waiting(), approved = damage.endsWith("approved"), contextChange = damage.startsWith("context"), command = await s.command();
  if (approved) expect((await s.decide("approve", "reviewer", command)).statusCode).toBe(200);
  await s.repository.mutate(state => {
    if (contextChange) (state.settings.rbac as any).runtimeApprovalPolicy.revision++;
    else stateRun(state).readProgress!.cancellation = { requestedAt: new Date().toISOString(), requestedBy: { id: "requester", name: "requester" } };
  });
  expect(await maintainProtectedApprovalWaits(s.services)).toBe(1); const closed = await s.record();
  expect(closed).toMatchObject({ state: "CLOSED", closure: { reason: contextChange ? "PROTECTED_APPROVAL_CONTEXT_CHANGED" : "PROTECTED_APPROVAL_CANCELLED" } });
  // Restore the previous live policy to isolate the public lifecycle-only
  // resurrection attempt. The CLOSED private journal and cursor stay untouched.
  await s.repository.mutate(state => { if (contextChange) (state.settings.rbac as any).runtimeApprovalPolicy.revision--; });
  const state = await s.repository.snapshot(), run = stateRun(state);
  run.protectedJobSecret!.state = "WAITING"; run.status = approved ? "BLOCKED" : "AWAITING_APPROVAL"; run.completedAt = null; delete run.readProgress!.cancellation;
  expect(() => restoreProtectedJob(state, s.services, runId)).toThrow(/wait/);
  const reviewer = (await s.repository.effectiveUser("reviewer"))!;
  expect(() => protectedApprovalView(state, s.services, runId, reviewer)).toThrow(/evidence/);
  // The pure transition also cannot decide or consume CLOSED data even if a
  // caller spoofs the untrusted public status and current policy.
  const authentic = await s.repository.snapshot(), saved = restoreProtectedJob(authentic, s.services, runId), context = currentProtectedApprovalContext(saved, authentic, s.services);
  const actor = { id: "reviewer", roleId: "review", active: true, permissions: ["execution:approve"] };
  if (!approved) expect(() => decideProtectedApprovalRecord(context, closed, command, actor, "APPROVED", Date.now())).toThrow();
  expect(() => consumeProtectedApprovalRecord(context, closed, actor, Date.now())).toThrow(); s.noCalls();
});

test.each(["cursor", "argument", "point", "reason", "decision", "missing-record"])("changed private %s fails authenticated restore and HTTP review/decision", async damage => {
  const s = await waiting(), command = await s.command(), state = await s.repository.snapshot(), run = stateRun(state), row = run.protectedApprovalSecret!.records[command.approvalId]!;
  if (damage === "cursor") { const bytes = Buffer.from(state.protectedContinuations[runId]!.ciphertext, "base64"); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; state.protectedContinuations[runId]!.ciphertext = bytes.toString("base64"); }
  if (damage === "argument") row.arguments.id = "private-item-B";
  if (damage === "point") { row.binding.pointHash = `sha256:${"e".repeat(64)}`; row.reviewHash = protectedApprovalReviewHash(row); }
  if (damage === "reason") { row.reason = "Changed private reason"; row.reviewHash = protectedApprovalReviewHash(row); }
  if (damage === "decision") { row.version = 2; row.state = "APPROVED"; row.decision = { actorId: "reviewer", roleId: "review", decisionKey: command.decisionKey,
    fingerprint: `sha256:${"e".repeat(64)}`, outcome: "APPROVED", note: command.note, decidedAt: new Date().toISOString() }; run.status = "BLOCKED"; }
  if (damage === "missing-record") delete run.protectedApprovalSecret!.records[command.approvalId];
  expect(() => restoreProtectedJob(state, s.services, runId)).toThrow();
  const reviewer = (await s.repository.effectiveUser("reviewer"))!; expect(() => protectedApprovalView(state, s.services, runId, reviewer)).toThrow();
  // Snapshot tampering cannot corrupt shared storage, but both server adapters
  // receive exactly the damaged private evidence for this bounded check.
  vi.spyOn(s.repository, "readAuthoritative").mockImplementation(async reader => reader(state));
  vi.spyOn(s.repository, "mutateExecution").mockImplementation(async (_id, mutation) => mutation(state));
  expect((await s.view()).statusCode).toBe(409); expect((await s.decide("approve", "reviewer", command)).statusCode).toBe(409); s.noCalls();
});

test("rehashing and resealing a foreign semantic point still fails exact historical replay", async () => {
  const s = await waiting(), state = await s.repository.snapshot(), saved = restoreProtectedJob(state, s.services, runId), row = stateRun(state).protectedApprovalSecret!.records[(await s.record()).id]!;
  row.binding.pointHash = `sha256:${"e".repeat(64)}`; row.reviewHash = protectedApprovalReviewHash(row);
  expect(() => assertProtectedApprovalRecords(stateRun(state).protectedApprovalSecret, stateRun(state).protectedInvocationSecret!)).not.toThrow();
  sealProtectedCursor(s.services, state, stateRun(state), saved.machine);
  expect(() => restoreProtectedJob(state, s.services, runId)).toThrow(/original exact item/); s.noCalls();
});

test("CLOSED journal strict consistency refuses ambiguous terminals, wrong reason/status/time and repeat closure", async () => {
  const s = await waiting(), row = await s.record(), state = await s.repository.snapshot(), ledger = stateRun(state).protectedInvocationSecret!;
  const closed = closeProtectedApprovalRecord(row, ledger, "PROTECTED_APPROVAL_CANCELLED", Date.now());
  expect(closed).toMatchObject({ state: "CLOSED", version: 2, closure: { status: "CANCELLED" } });
  expect(() => closeProtectedApprovalRecord(closed, ledger, "PROTECTED_APPROVAL_CANCELLED", Date.now())).toThrow();
  for (const damage of ["state", "version", "status", "clock", "expiry", "extra"] as const) {
    const damaged: any = structuredClone(closed);
    if (damage === "state") damaged.state = "PENDING"; if (damage === "version") damaged.version++;
    if (damage === "status") damaged.closure.status = "FAILED"; if (damage === "clock") damaged.closure.closedAt = new Date(Date.parse(row.requestedAt) - 1).toISOString();
    if (damage === "expiry") damaged.expiredAt = row.expiresAt; if (damage === "extra") damaged.closure.permit = true;
    expect(() => assertProtectedApprovalRecords({ profile: "protected-approvals/v1", count: 1, activeId: row.id, records: { [row.id]: damaged } }, ledger)).toThrow();
  }
  s.noCalls();
});

test("review inbox indexes exact independent item with no arguments or private evidence; requester cannot discover self", async () => {
  const s = await waiting(), row = await s.record(), response = await s.as("reviewer", "GET", "/api/execution-reviews?kind=approval&state=open");
  expect(response.statusCode, response.body).toBe(200); expect(response.json().data.items).toHaveLength(1);
  expect(response.json().data.items[0]).toMatchObject({ executionId: runId, reviewId: row.id, kind: "approval", nodeId: "send", actionable: true, canResume: false, noReplay: true });
  expect(response.json().data.items[0]).not.toHaveProperty("arguments");
  expect(response.body).not.toMatch(/private-item-A|private-item-B|protectedApprovalSecret|protectedInvocationSecret|reviewHash|intentKey|connectionBinding|ciphertext/);
  const self = await s.as("requester", "GET", "/api/execution-reviews?kind=approval&state=open"); expect(self.statusCode, self.body).toBe(200); expect(self.json().data.items).toEqual([]);
  expect((await s.view("requester")).statusCode).toBe(403); s.noCalls();
});

test.each(["approved", "rejected", "cancelled", "expired", "context-changed"] as const)("%s review history is readable, non-actionable and does not imply dispatch", async phase => {
  const s = await waiting();
  if (phase === "approved") await s.decide();
  if (phase === "rejected") await s.decide("reject");
  if (phase === "cancelled") await s.as("requester", "POST", `/api/executions/${runId}/cancel`, {});
  if (phase === "expired") {
    const row = await s.record(), clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(row.expiresAt));
    try { expect(await maintainProtectedApprovalWaits(s.services)).toBe(1); } finally { clock.mockRestore(); }
  }
  if (phase === "context-changed") {
    await s.repository.mutate(state => { state.workflows.flow!.archived = true; });
    expect(await maintainProtectedApprovalWaits(s.services)).toBe(1);
  }
  const expected = { approved: "APPROVED", rejected: "REJECTED", cancelled: "CLOSED", expired: "EXPIRED", "context-changed": "CLOSED" }[phase];
  const labels = { approved: "Approved — not delivery confirmation", rejected: "Rejected", cancelled: "Closed — not dispatched",
    expired: "Expired — not dispatched", "context-changed": "Closed — not dispatched" };
  const detail = await s.view(); expect(detail.statusCode, detail.body).toBe(200);
  const review = detail.json().data.runtimeApproval;
  expect(review).toMatchObject({ state: expected, canDecide: false, canResume: false, resumeQueued: false,
    invocationId: "each/0/send", arguments: { id: "private-item-A" } });
  if (phase === "cancelled" || phase === "context-changed") expect(review.closure).toMatchObject({
    reason: phase === "cancelled" ? "PROTECTED_APPROVAL_CANCELLED" : "PROTECTED_APPROVAL_CONTEXT_CHANGED",
    status: phase === "cancelled" ? "CANCELLED" : "FAILED" });
  if (phase === "expired") expect(review.expiredAt).toBe((await s.record()).expiresAt);
  const inbox = await s.as("reviewer", "GET", "/api/execution-reviews?kind=approval&state=closed");
  expect(inbox.statusCode, inbox.body).toBe(200); expect(inbox.json().data.items).toHaveLength(1);
  expect(inbox.json().data.items[0]).toMatchObject({ state: "closed", statusLabel: labels[phase as keyof typeof labels],
    reviewAvailable: true, actionable: false, canResume: false, noReplay: true });
  expect(inbox.body).not.toMatch(/private-item-A|private-item-B|intentKey|connectionBinding|protectedApprovalSecret/);
  const open = await s.as("reviewer", "GET", "/api/execution-reviews?kind=approval&state=open");
  expect(open.statusCode, open.body).toBe(200); expect(open.json().data.items).toEqual([]);
  const saved = await s.repository.snapshot(); expect(() => restoreProtectedJob(saved, s.services, runId)).not.toThrow();
  s.noCalls();
});

test("generic execution and events APIs never expose private approval or continuation evidence", async () => {
  const s = await waiting();
  for (const path of [`/api/executions/${runId}`, "/api/executions", `/api/executions/${runId}/events`]) {
    const response = await s.as("requester", "GET", path); expect(response.statusCode, response.body).toBe(200);
    // The owner can inspect authored workflow input through the existing
    // scoped execution API; it is not the private approval journal/permission.
    expect(response.json().data).not.toHaveProperty("runtimeApproval");
    expect(response.body).not.toMatch(/protectedApprovalSecret|protectedInvocationSecret|protectedJobSecret|protectedContinuations|approvalHash|admissionSeal|intentKey|connectionBinding|ciphertext|private-synthetic-token/);
  }
  s.noCalls();
});

test.each(["pending", "approved", "rejected", "cancelled"])("Retry cannot dispatch or replay a %s protected wait", async phase => {
  const s = await waiting(); if (phase === "approved") await s.decide(); if (phase === "rejected") await s.decide("reject");
  if (phase === "cancelled") await s.as("requester", "POST", `/api/executions/${runId}/cancel`, {});
  const before = await s.repository.snapshot(), response = await s.as("requester", "POST", `/api/executions/${runId}/retry`, {});
  expect(response.statusCode, response.body).toBe(409); expect(await s.repository.snapshot()).toEqual(before); s.noCalls();
});

test("normal internal/public full effect admission stays denied before any prefix or execution creation", async () => {
  const s = await fixture("effect"); closers.push(s);
  const base = await s.repository.readAuthoritative(state => ({ baseVersion: state.workflows.flow!.draftVersion, baseHash: workflowContentHash(state.workflows.flow!.yaml) }));
  await publishProtectedOperation(s.services, "flow", s.actor, base); s.sdk.listTools.mockClear();
  await expect(admitProtectedOperation(s.services, "flow", s.actor, { items: ["one"] }, requestKey)).rejects.toThrow(/drivers/);
  expect(s.sdk.listTools).not.toHaveBeenCalled();
  const response = await s.request("POST", "/api/workflows/flow/run", { mode: "async-operation", input: { items: ["one"] }, idempotencyKey: requestKey });
  expect(response.statusCode, response.body).toBe(422); expect(response.body).toContain("PROTECTED_COLLECTION_RUNTIME_PENDING");
  expect((await s.repository.snapshot()).executions).toEqual({}); expect(s.sdk.callTool).not.toHaveBeenCalled(); expect(s.modelFetch).not.toHaveBeenCalled();
});

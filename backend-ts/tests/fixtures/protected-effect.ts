import jwt from "jsonwebtoken";
import { protectedPreparationFixture } from "./protected-preparation.js";
import { fixtureSequence as seq, fixtureAction as action, fixtureRef as ref } from "./protected-simulation.js";
import { publishProtectedOperation, assertStoredProtectedOperationPublicationCurrent,
  type ProtectedOperationPublicationReceipt } from "../../src/workflows/protected-operation-publication.js";
import { workflowContentHash } from "../../src/parser/workflow.js";
import { ProtectedMachine } from "../../src/workflows/protected-machine.js";
import { ProtectedInvocationLedger } from "../../src/runner/protected-invocation-ledger.js";
import { newReadProgress } from "../../src/runner/read-checkpoints.js";
import { protectedAdmissionSeal, protectedHash as hash, sealProtectedCursor } from "../../src/runner/protected-job-state.js";
import type { Execution, Repository } from "../../src/repository/store.js";

/** TEST ONLY: sealed initial QUEUED job under a real current publication,
 * capability review, session and independent approval policy. Public effect
 * admission stays closed. Never fabricates consumption, SDK evidence, answers
 * or legacy journals. All subsequent transitions use the genuine owned driver.
 * SDK transport is synthetic; this is not live ERP/business qualification. */
export async function protectedEffectFixture(configure?: (source: any) => void, suppliedRepository?: Repository) {
  const s = await protectedPreparationFixture("effect", false, suppliedRepository);
  s.source.steps = [{ id: "send", action: s.tools[1]!.name, parameters: { id: "{{each.item}}" } }];
  s.source.metadata.controlFlow.root = seq({ kind: "foreach", id: "each", maxItems: 3,
    items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "workflowInput", path: ["items"] } },
    body: seq(action("send")), collect: { schema: { type: "boolean" }, value: ref("send", "structuredContent", "accepted") } },
    { kind: "return", id: "answer", output: { schema: { type: "array", items: { type: "boolean" } }, value: ref("each", "value") } });
  configure?.(s.source);
  await s.saveSource();
  await s.repository.mutate(state => {
    state.users.reviewer = { ...state.users.requester!, id: "reviewer", name: "Independent reviewer", email: "reviewer@example.test", roleId: "review" };
  });
  const base = await s.repository.readAuthoritative(state => ({ baseVersion: state.workflows.flow!.draftVersion,
    baseHash: workflowContentHash(state.workflows.flow!.yaml) }));
  const publication = await publishProtectedOperation(s.services, "flow", s.actor, base);
  s.sdk.callTool.mockImplementation((async () => ({ content: [], structuredContent: { accepted: true } })) as any);
  const runId = "test-only-owned-effect-run";
  const seed = (items = ["one", "two"]) => s.repository.mutate(state => {
    const stored = state.versions.flow!.find(version => version.id === publication.id)!;
    const plan = assertStoredProtectedOperationPublicationCurrent(state, s.services, String(stored.id), "flow", s.actor.role);
    const receipt = structuredClone(stored.protectedCompilation) as ProtectedOperationPublicationReceipt;
    const input = { items }, createdAt = new Date().toISOString();
    const machine = new ProtectedMachine(plan.machine, input); machine.peek();
    const ledger = new ProtectedInvocationLedger({ executionId: runId, workflowId: "flow", actorId: s.actor.id, roleId: s.actor.roleId,
      admittedRole: s.actor.role, sourceHash: plan.sourceHash, operationHash: plan.semanticHash, machineHash: plan.machine.semanticHash, inputHash: hash(input) }, plan.machine, machine);
    const run: Execution = { id: runId, workflowId: "flow", workflowName: "Test-only owned effects", status: "PENDING",
      startedBy: { id: s.actor.id, name: s.actor.name }, startedAt: createdAt, completedAt: null, durationMs: 0, costUsd: 0,
      tokens: { input: 0, output: 0, total: 0 }, stepOutputs: {}, readProgress: newReadProgress(s.repository),
      workflowSnapshot: { yaml: stored.yaml as string, version: receipt.version, contentHash: plan.sourceHash, registryHash: receipt.registryHash,
        input, executionProfile: "protected-operation-v1", protectedCompilation: receipt }, protectedInvocationSecret: ledger.snapshot(),
      protectedJobSecret: { profile: "protected-operation-job/v1", actorId: s.actor.id, roleId: s.actor.roleId, admittedRole: s.actor.role,
        departmentId: s.actor.departmentId, permissionsHash: hash([...new Set(s.actor.permissions)].sort()), publicationId: String(stored.id),
        idempotencyScope: hash(["test-only-owned-effects", runId]), requestFingerprint: hash({ workflowId: "flow", input }),
        createdAt, state: "QUEUED", admissionSeal: "0".repeat(64) } };
    run.protectedJobSecret!.admissionSeal = protectedAdmissionSeal(s.services, run);
    state.executions[runId] = run; state.timelines[runId] = []; state.executionLogs[runId] = []; state.executionEvents[runId] = [];
    sealProtectedCursor(s.services, state, run, machine);
  });
  const as = (userId: string, method: "GET" | "POST", path: string, payload?: unknown) => s.app.inject({ method, url: `/api/executions/${runId}${path}`,
    headers: { authorization: `Bearer ${jwt.sign({}, s.config.jwtSecret, { subject: userId, expiresIn: 3600 })}` },
    ...(payload === undefined ? {} : { payload: payload as object }) });
  const active = () => s.repository.readAuthoritative(state => {
    const journal = state.executions[runId]!.protectedApprovalSecret!;
    return structuredClone(journal.records[journal.activeId!]!);
  });
  const decide = async (outcome = "approve", userId = "reviewer") => {
    const record = await active();
    return as(userId, "POST", `/${outcome}`, { approvalId: record.id, baseVersion: record.version,
      reviewHash: record.reviewHash, decisionKey: `test-owned-effect-decision-${record.id}`, note: "Review this exact item only" });
  };
  return { ...s, runId, publication, seed, as, active, decide };
}

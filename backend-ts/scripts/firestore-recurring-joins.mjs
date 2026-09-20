import assert from "node:assert/strict";
import { stringify } from "yaml";
import { recurringCrossJoinWorkflow, recurringJoinWorkflow } from "../tests/fixtures/recurring-join-workflow.js";
import { recurringAutomationCandidateContext, recurringDeliveryRequest } from "../src/delivery/recurring-automation.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../src/parser/workflow.js";
import { workflowScheduleRunner } from "../src/runner/workflow-schedules.js";
import { prepareRecurringAnalysisFixture, reviewFixtureAnalysisEgress } from "./firestore-recurring-analysis.mjs";

// Qualification fixture only, called inside the exact credential-free demo
// emulator harness. All inference and ERP/email dispatch are in-process fakes.
export async function verifyFirestoreRecurringJoins(context) {
  const { getRepository, getServices, restart, request, waitFor, log, tools, setSynthesisFixture, setAnalysisFixture, models, relatedInvoiceReports, relatedOrderReports, emails } = context;
  const snapshot = () => getRepository().snapshot();
  const cases = ["reports", "branch-analysis", "joined-analysis"].flatMap(mode => [true, false].map(selected => ({ mode, selected, loseACK: false })));
  cases.push(...[true, false].map(selected => ({ mode: "joined-analysis", selected, loseACK: true })));
  cases.push(...[true, false].flatMap(selected => [false, true].map(loseACK => ({ mode: "reports", crossKeys: true, selected, loseACK }))));
  const restoreProvider = await reviewFixtureAnalysisEgress(context);
  try { for (const { mode, crossKeys = false, selected, loseACK } of cases) {
    const caseId = (crossKeys ? "cross-join-keys" : mode) + "-" + selected + "-" + (loseACK ? "lostACK" : "normal");
    const candidate = crossKeys ? recurringCrossJoinWorkflow(tools, "reportId") : recurringJoinWorkflow(tools, mode, "reportId"), text = "Create a workflow to " + candidate.text;
    const analysisFixture = prepareRecurringAnalysisFixture(candidate.workflow, mode, selected, tools), analysisCalls = [];
    const originalRequest = recurringDeliveryRequest(text);
    candidate.workflow.metadata.automation_request = structuredClone(recurringAutomationCandidateContext(originalRequest).automation_request);
    const before = { models: models.length, invoices: relatedInvoiceReports.length, orders: relatedOrderReports.length, emails: emails.length, executions: Object.keys((await snapshot()).executions).length };
    const chat = (await request("POST", "/api/chat/sessions", {}, 201)).data;
    const command = { content: text, delivery: "async-chat", idempotencyKey: "firestore-recurring-join-chat-" + caseId + "-0001" };
    setSynthesisFixture(candidate.workflow);
    let operationId;
    try {
      operationId = (await request("POST", "/api/chat/sessions/" + chat.id + "/messages", command, 202)).data.operation.id;
      await waitFor(async () => (await snapshot()).chatOperations[operationId].status === "ANSWERED", "recurring typed-join background proposal");
    } finally { setSynthesisFixture(undefined); }
    const state = await snapshot(), operation = state.chatOperations[operationId], workflowId = operation.artifactRefs.find(ref => ref.type === "workflow-draft").id;
    const original = structuredClone(state.workflows[workflowId]), messages = structuredClone(state.chats[chat.id].messages);
    assert.deepEqual(parseWorkflowYAMLStrict(original.yaml), candidate.workflow); assert.equal(original.publishedVersion, 0); assert.equal(original.canRun, false);
    const artifact = messages.at(-1).artifacts;
    assert.equal(artifact.automationComposition.status, "CAPABILITIES_MAPPED"); assert.equal(artifact.automationComposition.deliveryBodyBound, true);
    assert.equal(artifact.automationComposition.analysis.status, mode === "reports" ? "NOT_REQUESTED" : "MAPPED");
    assert.equal(artifact.automationComposition.readyForPublication, false); assert.equal(artifact.automationComposition.scheduleActive, false);
    assert.equal(artifact.automationRequest.decisionRequest.originalRequest, text);
    assert.equal(models.length, before.models + 1); assert.equal(relatedInvoiceReports.length, before.invoices); assert.equal(relatedOrderReports.length, before.orders);
    assert.equal(emails.length, before.emails); assert.equal(Object.keys(state.executions).length, before.executions);
    await request("POST", "/api/workflows/" + workflowId + "/publish", {}, 422);
    await restart(); assert.deepEqual((await snapshot()).workflows[workflowId], original);
    assert.equal((await request("POST", "/api/chat/sessions/" + chat.id + "/messages", command, 202)).data.operation.id, operationId);
    assert.deepEqual((await snapshot()).chats[chat.id].messages, messages); assert.equal(models.length, before.models + 1);

    // Explicit synthetic owner's reviewed draft edit, not an automatic planner
    // repair. This test supplies review/activation facts and removes the gates
    // through the same revision-bound HTTP command as an intentional user edit.
    const reviewed = structuredClone(candidate.workflow); reviewed.metadata.unresolved_requirements = [];
    const edited = (await request("POST", "/api/workflows/" + workflowId + "/commands", {
      baseVersion: original.draftVersion, baseHash: workflowContentHash(original.yaml), command: { type: "restoreDraft", yaml: stringify(reviewed) },
    }, 200)).data;
    assert.equal(edited.version, original.draftVersion + 1); assert.equal(emails.length, before.emails);
    assert.equal((await request("POST", "/api/workflows/" + workflowId + "/publish", {}, 200)).data.compiledOperation.schemaVersion, "workflow-operation-ir/v7");
    const publication = (await snapshot()).workflows[workflowId];
    await getRepository().mutate(next => { for (const saved of Object.values(next.schedules)) { saved.state = "PAUSED"; saved.nextRunAt = null; } });
    const schedule = (await request("PUT", "/api/workflows/" + workflowId + "/schedule", { profile: "workflow-daily-schedule-command/v1", baseRevision: 0,
      workflowVersion: publication.publishedVersion, workflowHash: workflowContentHash(publication.yaml), enabled: true, timezone: "UTC",
      localTime: new Date(Date.now() + 120_000).toISOString().slice(11, 16), reportingPeriod: "previous-calendar-day", misfirePolicy: "FIRE_ONCE", misfireGraceSeconds: 300,
      servicePrincipalId: "owner", input: { usePrimary: selected }, reportWindowBinding: { profile: "workflow-report-window-input-binding/v1", startAtInput: "reportStartAt", endAtInput: "reportEndAt" },
    }, 200)).data;
    assert.equal(emails.length, before.emails); assert.equal(relatedInvoiceReports.length, before.invoices);
    if (mode !== "reports") setAnalysisFixture(async data => {
      const run = Object.values((await snapshot()).executions).find(run => run.workflowId === workflowId && run.status === "RUNNING");
      assert.ok(run); const result = analysisFixture(data, run); analysisCalls.push(result); return result.output;
    });
    const persistence = getRepository().persistence, checkpointWriter = persistence.saveExecutionCheckpoint.bind(persistence);
    let lostACK = false;
    if (loseACK) persistence.saveExecutionCheckpoint = async checkpoint => {
      await checkpointWriter(checkpoint);
      if (!lostACK && checkpoint.execution?.workflowId === workflowId &&
          (crossKeys ? checkpoint.execution.valueOutputs?.gate : checkpoint.execution.stepOutputs?.joined_analysis)) {
        lostACK = true; throw new Error("Synthetic recurring joined result post-COMMIT acknowledgement loss");
      }
    };
    let pending;
    try {
      await workflowScheduleRunner(getServices()).runDue(Date.parse(schedule.nextRunAt));
      if (loseACK) {
        await waitFor(() => lostACK, "recurring joined analysis acknowledgement loss");
        persistence.saveExecutionCheckpoint = checkpointWriter; await getRepository().recoverPersistenceState();
        pending = Object.values((await snapshot()).executions).find(run => run.workflowId === workflowId);
      } else pending = await waitFor(async () => Object.values((await snapshot()).executions).find(run => run.workflowId === workflowId && run.status === "AWAITING_APPROVAL"), "generated recurring join independent approval");
    } finally { persistence.saveExecutionCheckpoint = checkpointWriter; setAnalysisFixture(undefined); }
    const own = selected ? "yes" : "no", other = selected ? "no" : "yes";
    assert.deepEqual(Object.keys(pending.reportCoverages).sort(),
      [own + "_invoices", ...(crossKeys && loseACK ? [] : [crossKeys ? "shared_orders" : own + "_orders"])].sort());
    assert.equal(pending.stepOutputs[other + "_invoices"], undefined); assert.equal(pending.stepOutputs[other + "_orders"], undefined);
    const analysisOutputs = Object.fromEntries(analysisCalls.map(call => [call.nodeId, call.output]));
    for (const [id, output] of Object.entries(analysisOutputs)) {
      assert.deepEqual(pending.stepOutputs[id].structuredContent, output);
      assert.equal(pending.readProgress.attempts[id].status, "DONE"); assert.equal(pending.operationSecret.intents[id].state, "ACKNOWLEDGED");
    }
    const expectedModels = mode === "reports" ? 0 : mode === "branch-analysis" ? 2 : 1;
    assert.equal(analysisCalls.length, expectedModels); assert.equal(models.length, before.models + 1 + expectedModels);
    assert.equal(pending.tokens.total, expectedModels * 18);
    const expectedGate = crossKeys ? { invoices: "related-report-operation", orderIds: pending.stepOutputs[own + "_invoices"].structuredContent.orderIds } :
      mode === "reports" ? { invoices: "related-report-operation", orders: "related-report-operation" } :
      mode === "branch-analysis" ? { invoices: analysisOutputs[own + "_invoice_analysis"].text, orders: analysisOutputs[own + "_order_analysis"].text } :
      { invoices: pending.stepOutputs[own + "_invoices"].structuredContent, orders: pending.stepOutputs[own + "_orders"].structuredContent };
    assert.deepEqual(pending.valueOutputs.gate, { value: expectedGate });
    if (mode === "branch-analysis") for (const suffix of ["invoice_analysis", "order_analysis"]) {
      assert.equal(pending.stepOutputs[other + "_" + suffix], undefined); assert.equal(pending.operationSecret.intents[other + "_" + suffix], undefined);
    }
    assert.equal(pending.finalOutput, undefined); assert.equal(emails.length, before.emails);
    assert.equal(pending.operationSecret.intents.deliver, undefined);
    const savedEvents = structuredClone((await snapshot()).executionEvents[pending.id]);
    await restart();
    if (loseACK) {
      const restored = (await snapshot()).executions[pending.id]; assert.equal(restored.status, "RECOVERY_REQUIRED");
      assert.deepEqual(restored.stepOutputs, pending.stepOutputs); assert.deepEqual(restored.valueOutputs, pending.valueOutputs);
      assert.deepEqual(restored.reportCoverages, pending.reportCoverages); assert.equal(restored.finalOutput, undefined);
      assert.equal(restored.runtimeApprovalSecret, undefined); assert.equal(restored.operationSecret.intents.deliver, undefined);
      if (crossKeys) { assert.equal(restored.stepOutputs.shared_orders, undefined); assert.equal(restored.operationSecret.intents.shared_orders, undefined); }
      const events = (await snapshot()).executionEvents[pending.id];
      assert.deepEqual(events.slice(0, savedEvents.length), savedEvents); assert.equal(events.length, savedEvents.length + 1);
      assert.equal(events.at(-1).type, "run.recovery_required");
    } else {
    assert.deepEqual((await snapshot()).executions[pending.id], pending);
    const review = (await request("GET", "/api/executions/" + pending.id + "?view=approval", undefined, 200, "reviewer")).data.runtimeApproval;
    const decision = { approvalId: review.id, baseVersion: review.version, reviewHash: review.reviewHash, decisionKey: "approve-generated-calendar-join-" + caseId };
    await request("POST", "/api/executions/" + pending.id + "/approve", decision, 403, "owner");
    await request("POST", "/api/executions/" + pending.id + "/approve", decision, 200, "reviewer");
    await waitFor(async () => (await snapshot()).executions[pending.id].status === "DONE", "generated recurring joined fixture acceptance");
    const done = structuredClone((await snapshot()).executions[pending.id]); assert.equal(done.finalOutput, true);
    assert.deepEqual(done.valueOutputs.answer, { value: true }); assert.deepEqual(emails.at(-1), {
      recipient: "manager@example.test", subject: "Daily chosen invoice and order report", body: mode === "joined-analysis" ? analysisOutputs.joined_analysis.text :
        "Invoices: " + expectedGate.invoices + "\nOrders: " + (crossKeys ? done.stepOutputs.shared_orders.structuredContent.reportId : expectedGate.orders),
    });
    await restart(); assert.deepEqual((await snapshot()).executions[pending.id], done);
    }
    const events = structuredClone((await snapshot()).executionEvents[pending.id]);
    assert.deepEqual(await workflowScheduleRunner(getServices()).runDue(Date.parse(schedule.nextRunAt)), { admitted: 0, skipped: 0, blocked: 0 });
    assert.deepEqual((await snapshot()).executionEvents[pending.id], events);
    assert.equal(models.length, before.models + 1 + expectedModels); assert.equal(relatedInvoiceReports.length, before.invoices + 1);
    assert.equal(relatedOrderReports.length, before.orders + (crossKeys && loseACK ? 0 : 1)); assert.equal(emails.length, before.emails + (loseACK ? 0 : 1));
    assert.equal(Object.values((await snapshot()).executions).filter(run => run.workflowId === workflowId).length, 1);
    log("actual Firestore v17 recurring joined chat " + caseId + ": exact inactive draft/restart/chat replay, explicit review/publication/calendar activation, selected-only report/model answers, " +
      (loseACK ? (crossKeys ? "persisted selected key join but fenced related read and delivery after lost ACK, recovery-required restart" :
        "persisted analysis answer but fenced dependent delivery after lost ACK, recovery-required restart") : "separate approval restart, one fixture acceptance/final answer") + " and no replay");
  } } finally { setAnalysisFixture(undefined); setSynthesisFixture(undefined); await restoreProvider(); }
}

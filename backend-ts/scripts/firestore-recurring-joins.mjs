import assert from "node:assert/strict";
import { stringify } from "yaml";
import { recurringJoinWorkflow } from "../tests/fixtures/recurring-join-workflow.js";
import { recurringAutomationCandidateContext, recurringDeliveryRequest } from "../src/delivery/recurring-automation.js";
import { parseWorkflowYAMLStrict, workflowContentHash } from "../src/parser/workflow.js";
import { workflowScheduleRunner } from "../src/runner/workflow-schedules.js";

// Qualification fixture only, called inside the exact credential-free demo
// emulator harness. All inference and ERP/email dispatch are in-process fakes.
export async function verifyFirestoreRecurringJoins(context) {
  const { getRepository, getServices, restart, request, waitFor, log, tools, setSynthesisFixture, models, relatedInvoiceReports, relatedOrderReports, emails } = context;
  const snapshot = () => getRepository().snapshot();
  for (const selected of [true, false]) {
    const candidate = recurringJoinWorkflow(tools, "reports", "reportId"), text = "Create a workflow to " + candidate.text;
    const originalRequest = recurringDeliveryRequest(text);
    candidate.workflow.metadata.automation_request = structuredClone(recurringAutomationCandidateContext(originalRequest).automation_request);
    const before = { models: models.length, invoices: relatedInvoiceReports.length, orders: relatedOrderReports.length, emails: emails.length, executions: Object.keys((await snapshot()).executions).length };
    const chat = (await request("POST", "/api/chat/sessions", {}, 201)).data;
    const command = { content: text, delivery: "async-chat", idempotencyKey: "firestore-recurring-join-chat-" + selected + "-0001" };
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
    await workflowScheduleRunner(getServices()).runDue(Date.parse(schedule.nextRunAt));
    const pending = await waitFor(async () => Object.values((await snapshot()).executions).find(run => run.workflowId === workflowId && run.status === "AWAITING_APPROVAL"), "generated recurring join independent approval");
    const own = selected ? "yes" : "no", other = selected ? "no" : "yes";
    assert.deepEqual(Object.keys(pending.reportCoverages), [own + "_invoices", own + "_orders"]);
    assert.equal(pending.stepOutputs[other + "_invoices"], undefined); assert.equal(pending.stepOutputs[other + "_orders"], undefined);
    assert.deepEqual(pending.valueOutputs.gate, { value: { invoices: "related-report-operation", orders: "related-report-operation" } });
    assert.equal(pending.finalOutput, undefined); assert.equal(emails.length, before.emails);
    await restart(); assert.deepEqual((await snapshot()).executions[pending.id], pending);
    const review = (await request("GET", "/api/executions/" + pending.id + "?view=approval", undefined, 200, "reviewer")).data.runtimeApproval;
    const decision = { approvalId: review.id, baseVersion: review.version, reviewHash: review.reviewHash, decisionKey: "approve-generated-calendar-join-" + selected };
    await request("POST", "/api/executions/" + pending.id + "/approve", decision, 403, "owner");
    await request("POST", "/api/executions/" + pending.id + "/approve", decision, 200, "reviewer");
    await waitFor(async () => (await snapshot()).executions[pending.id].status === "DONE", "generated recurring joined fixture acceptance");
    const done = structuredClone((await snapshot()).executions[pending.id]); assert.equal(done.finalOutput, true);
    assert.deepEqual(done.valueOutputs.answer, { value: true }); assert.deepEqual(emails.at(-1), {
      recipient: "manager@example.test", subject: "Daily chosen invoice and order report", body: "Invoices: related-report-operation\nOrders: related-report-operation",
    });
    await restart(); assert.deepEqual((await snapshot()).executions[pending.id], done);
    const events = structuredClone((await snapshot()).executionEvents[pending.id]);
    assert.deepEqual(await workflowScheduleRunner(getServices()).runDue(Date.parse(schedule.nextRunAt)), { admitted: 0, skipped: 0, blocked: 0 });
    assert.deepEqual((await snapshot()).executionEvents[pending.id], events);
    assert.equal(models.length, before.models + 1); assert.equal(relatedInvoiceReports.length, before.invoices + 1); assert.equal(relatedOrderReports.length, before.orders + 1); assert.equal(emails.length, before.emails + 1);
    log("actual Firestore v17 recurring joined chat selected=" + selected + ": exact inactive draft/restart/chat replay, explicit revision-bound review edit/publication/calendar activation, selected-only related reports, separate approval restart, one fixture acceptance/final answer and no replay");
  }
}

import assert from "node:assert/strict";
import { stringify } from "yaml";
import { workflowContentHash } from "../src/parser/workflow.js";
import { workflowScheduleRunner } from "../src/runner/workflow-schedules.js";

// Called only by the fixed-loopback, credential-free Firestore qualification
// harness. All model/MCP calls are that harness's in-process fixtures. This
// module exercises actual encrypted record transactions, not a mock store.
export async function verifyFirestoreCalendarJoins(context) {
  const { getRepository, getPersistence, getServices, restart, request, waitFor, log,
    reportTool, relatedInvoiceTool, relatedOrderTool, operationTool, reportWindowBinding,
    reports, relatedInvoiceReports, relatedOrderReports, operations, models } = context;
  const cases = ["cursor", "related"].flatMap(profile => [true, false].map(selected => ({ profile, selected, lost: null })))
    .concat(["merge", "report"].flatMap(lost => [true, false].map(selected => ({ profile: "cursor", selected, lost }))));
  const snapshot = () => getRepository().snapshot();
  for (const { profile, selected, lost } of cases) {
    const workflowId = "calendarJoin_" + profile + "_" + selected + "_" + (lost ?? "normal");
    const own = selected ? "yes_report" : "no_report", other = selected ? "no_report" : "yes_report";
    const action = nodeId => ({ kind: "action", nodeId }), seq = (...nodes) => ({ kind: "sequence", nodes });
    const ref = (nodeId, field) => ({ kind: "ref", source: "nodeOutput", nodeId, path: ["structuredContent", field] });
    const steps = [], branch = nodeId => {
      steps.push({ id: nodeId, action: (profile === "related" ? relatedInvoiceTool : reportTool).name,
        parameters: { startAt: "{{input.reportStartAt}}", endAt: "{{input.reportEndAt}}" } });
      const nodes = [action(nodeId)];
      if (profile === "related") {
        const id = nodeId + "_orders";
        steps.push({ id, action: relatedOrderTool.name, parameters: { startAt: "{{input.reportStartAt}}", endAt: "{{input.reportEndAt}}", orderIds: "{{" + nodeId + ".structuredContent.orderIds}}" } });
        nodes.push(action(id));
      }
      return seq(...nodes);
    };
    const gate = { kind: "if", id: "gate", predicate: { kind: "ref", source: "workflowInput", path: ["sendReport"] },
      then: branch("yes_report"), else: branch("no_report"),
      merge: { schema: { type: "string" }, then: ref("yes_report", "reportId"), else: ref("no_report", "reportId") } };
    steps.push({ id: "send", action: operationTool.name, parameters: { id: "{{gate.value}}" } });
    const source = { name: workflowId, description: "Selected complete report evidence through a durable typed join and separately approved fixture effect.",
      trigger: { type: "manual", config: { inputSchema: { type: "object", properties: { reportStartAt: { type: "string" }, reportEndAt: { type: "string" }, sendReport: { type: "boolean" } },
        required: ["reportStartAt", "reportEndAt", "sendReport"], additionalProperties: false } } }, steps,
      metadata: { controlFlow: { schemaVersion: "read-control-flow/v2", root: seq(gate, action("send"),
        { kind: "return", id: "accepted_answer", output: { schema: { type: "boolean" }, value: ref("send", "accepted") } }) } } };
    await getRepository().mutate(state => {
      for (const schedule of Object.values(state.schedules)) { schedule.state = "PAUSED"; schedule.nextRunAt = null; }
      state.workflows[workflowId] = { ...state.workflows.operation, id: workflowId, name: workflowId, yaml: stringify(source), steps: steps.length, publishedVersion: 0, draftVersion: 1, canRun: false };
      state.versions[workflowId] = [];
    });
    assert.equal((await request("POST", "/api/workflows/" + workflowId + "/publish", {}, 200)).data.compiledOperation.schemaVersion, "workflow-operation-ir/v7");
    const publication = (await snapshot()).workflows[workflowId];
    const before = { cursor: reports.length, invoices: relatedInvoiceReports.length, orders: relatedOrderReports.length, effects: operations.length, models: models.length };
    const schedule = (await request("PUT", "/api/workflows/" + workflowId + "/schedule", {
      profile: "workflow-daily-schedule-command/v1", baseRevision: 0, workflowVersion: publication.publishedVersion,
      workflowHash: workflowContentHash(publication.yaml), enabled: true, timezone: "UTC",
      localTime: new Date(Date.now() + 120_000).toISOString().slice(11, 16), reportingPeriod: "previous-calendar-day",
      misfirePolicy: "FIRE_ONCE", misfireGraceSeconds: 300, servicePrincipalId: "owner", input: { sendReport: selected }, reportWindowBinding,
    }, 200)).data;
    assert.equal(reports.length, before.cursor); assert.equal(relatedInvoiceReports.length, before.invoices);
    assert.equal(relatedOrderReports.length, before.orders); assert.equal(operations.length, before.effects);
    const persistence = getPersistence(), checkpointWriter = persistence.saveExecutionCheckpoint.bind(persistence);
    let lostACK = false;
    if (lost) persistence.saveExecutionCheckpoint = async checkpoint => {
      await checkpointWriter(checkpoint);
      const run = checkpoint.execution;
      const selectedCheckpoint = lost === "merge" ? run?.readProgress?.values?.gate?.status === "DONE" : Boolean(run?.reportCoverages?.[own]);
      if (!lostACK && run?.workflowId === workflowId && run.status === "RUNNING" && selectedCheckpoint) {
        lostACK = true;
        throw new Error("Synthetic actual Firestore calendar " + lost + " post-COMMIT acknowledgement loss");
      }
    };
    try {
      await workflowScheduleRunner(getServices()).runDue(Date.parse(schedule.nextRunAt));
      if (lost) {
        await waitFor(() => lostACK, "calendar " + lost + " checkpoint acknowledgement loss");
        persistence.saveExecutionCheckpoint = checkpointWriter;
        await getRepository().recoverPersistenceState();
      } else await waitFor(async () => Object.values((await snapshot()).executions).find(run => run.workflowId === workflowId && run.status === "AWAITING_APPROVAL"), "calendar join independent approval wait");
    } finally { persistence.saveExecutionCheckpoint = checkpointWriter; }
    const saved = Object.values((await snapshot()).executions).find(run => run.workflowId === workflowId);
    assert.ok(saved);
    const id = saved.id, answer = profile === "related" ? "related-report-operation" : "scheduled-operation";
    assert.deepEqual(Object.keys(saved.reportCoverages), profile === "related" ? [own, own + "_orders"] : [own]);
    assert.equal(saved.stepOutputs[other], undefined); assert.equal(saved.reportCoverages[other], undefined);
    assert.equal(saved.stepOutputs.send, undefined); assert.equal(saved.operationSecret.intents.send, undefined);
    assert.equal(saved.finalOutput, undefined);
    if (lost === "report") assert.equal(saved.valueOutputs?.gate, undefined);
    else { assert.deepEqual(saved.valueOutputs.gate, { value: answer }); assert.equal(saved.readProgress.values.gate.kind, "merge"); }
    if (profile === "cursor") assert.equal(saved.reportCoverages[own].pagination.pageCount, 3);
    if (lost) assert.equal(saved.runtimeApprovalSecret, undefined);
    const savedEvents = structuredClone((await snapshot()).executionEvents[id]);
    await restart();
    const restored = (await snapshot()).executions[id];
    assert.equal(restored.status, lost ? "RECOVERY_REQUIRED" : "AWAITING_APPROVAL");
    assert.deepEqual(restored.reportCoverages, saved.reportCoverages); assert.deepEqual(restored.valueOutputs, saved.valueOutputs);
    assert.deepEqual(restored.stepOutputs, saved.stepOutputs);
    if (lost) {
      const events = (await snapshot()).executionEvents[id];
      assert.deepEqual(events.slice(0, savedEvents.length), savedEvents);
      assert.equal(events.length, savedEvents.length + 1); assert.equal(events.at(-1).type, "run.recovery_required");
      assert.equal(restored.runtimeApprovalSecret, undefined); assert.equal(restored.operationSecret.intents.send, undefined);
    } else {
      assert.deepEqual(restored, saved); assert.deepEqual((await snapshot()).executionEvents[id], savedEvents);
      const review = (await request("GET", "/api/executions/" + id + "?view=approval", undefined, 200, "reviewer")).data.runtimeApproval;
      const command = { approvalId: review.id, baseVersion: review.version, reviewHash: review.reviewHash, decisionKey: "approve-" + workflowId };
      await request("POST", "/api/executions/" + id + "/approve", command, 403, "owner");
      assert.equal(operations.length, before.effects);
      await request("POST", "/api/executions/" + id + "/approve", command, 200, "reviewer");
      await waitFor(async () => (await snapshot()).executions[id].status === "DONE", "calendar joined approved fixture effect");
      const done = structuredClone((await snapshot()).executions[id]);
      assert.equal(done.finalOutput, true); assert.deepEqual(done.valueOutputs.accepted_answer, { value: true });
      assert.equal(operations.at(-1), answer);
      await restart(); assert.deepEqual((await snapshot()).executions[id], done);
    }
    const events = structuredClone((await snapshot()).executionEvents[id]);
    assert.deepEqual(await workflowScheduleRunner(getServices()).runDue(Date.parse(schedule.nextRunAt)), { admitted: 0, skipped: 0, blocked: 0 });
    assert.deepEqual((await snapshot()).executionEvents[id], events);
    assert.equal(Object.values((await snapshot()).executions).filter(run => run.workflowId === workflowId).length, 1);
    assert.equal(reports.length, before.cursor + (profile === "cursor" ? 3 : 0));
    assert.equal(relatedInvoiceReports.length, before.invoices + (profile === "related" ? 1 : 0));
    assert.equal(relatedOrderReports.length, before.orders + (profile === "related" ? 1 : 0));
    assert.equal(operations.length, before.effects + (lost ? 0 : 1)); assert.equal(models.length, before.models);
    log("actual Firestore calendar join " + profile + "/selected=" + selected + "/" + (lost ? lost + "-lostACK" : "normal") + ": exact selected report evidence, " +
      (lost ? "fenced dependent dispatch and retained recovery-required answer" : "fresh approval restart, independent effect decision and saved final answer restart") + ", no occurrence/report/effect replay");
  }
}

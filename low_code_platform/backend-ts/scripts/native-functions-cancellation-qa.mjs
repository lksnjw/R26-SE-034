// Native cancellation evidence, not a model/ERP mock or a product retry wrapper.
// The existing guarded Docker read campaign must establish discovery/review.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { nativeModelIds, startNativeModelFixture } from "./native-functions-model-qa.mjs";
import { assertChatTaskOutbox } from "../src/agent/chat-task-outbox.js";

/** One bounded, deliberately held completion; release never resends a request. */
export function completionBarrier(timeoutMs = 25_000) {
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 10 && timeoutMs <= 25_000);
  let entered = false, released = false, expired = false, enteredAt, releasedAt, timer, enter, finish;
  const started = new Promise(resolve => { enter = resolve; });
  const ended = new Promise(resolve => { finish = resolve; });
  const release = () => {
    if (released) return;
    released = true; releasedAt = Date.now(); clearTimeout(timer); finish();
  };
  return {
    started, release,
    async hold() {
      assert(!entered && !released, "Completion barrier may only be entered once");
      entered = true; enteredAt = Date.now();
      timer = setTimeout(() => { expired = true; release(); }, timeoutMs);
      enter(); await ended;
    },
    observation() { return { entered, released, expired, enteredAt: enteredAt ?? null, releasedAt: releasedAt ?? null, timeoutMs }; },
  };
}

export function cancellationReportName(label) {
  assert(label === undefined || typeof label === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(label), "Use a bounded report label, never a path");
  return `native-held-model-cancellation${label === undefined ? "" : `-${label}`}.json`;
}

export async function qualifyNativeCancellation({ request, open, config, reportLabel }) {
  const reportName = cancellationReportName(reportLabel);
  assert.equal(config.FUNCTIONS_WRITER_ADMISSION_TIMEOUT_MS, "5000", "Use the explicit original admission diagnostic budget");
  const barrier = completionBarrier(); let armed = false, held = false, fixture;
  fixture = await startNativeModelFixture(config, { beforeReply: async () => {
    if (armed && !held) { held = true; await barrier.hold(); }
  } });
  try {
    const expect = async (path, method, payload, status = 200) => {
      const result = await request("api", path, method, payload);
      assert.equal(result.status, status, result.body); assert(!result.body.includes(fixture.apiKey), "Provider credential escaped HTTP"); return result.data.data;
    };
    const provider = await expect("/api/providers", "POST", {
      name: "LOCAL cancellation planning fixture", type: "openai_compatible", baseUrl: fixture.baseUrl, apiKey: fixture.apiKey,
      model: nativeModelIds[0], temperature: 0,
      egressPolicy: { approvedOrigin: new URL(fixture.baseUrl).origin, confirmed: true, interactiveDataClasses: ["restricted"], runtimeAnalysisDataClasses: [], runtimeAgentDataClasses: [] },
    }, 201);
    assert.equal((await expect(`/api/providers/${provider.id}/test`, "POST", {})).ok, true);
    await expect(`/api/providers/${provider.id}/activate`, "POST", {});
    const chat = await expect("/api/chat/sessions", "POST", { title: "LOCAL native cancellation", idempotencyKey: "native-cancel-create-0001" }, 201);
    const command = { content: "List the synthetic Departments from ERPBridge.", model: nativeModelIds[0], delivery: "async-chat", idempotencyKey: "native-cancel-query-0001" };
    armed = true;
    const admission = await expect(`/api/chat/sessions/${chat.id}/messages`, "POST", command, 202);
    assert.equal(admission.taskDispatch, "ENQUEUED");
    // Deadline for observing entry is independent of the held provider request.
    const entered = new AbortController();
    try { await Promise.race([barrier.started, pause(20_000, undefined, { signal: entered.signal }).then(() => { throw new Error("Native model request did not enter the held completion"); })]); }
    finally { entered.abort(); }
    const progressStarted = Date.now();
    const before = await expect(`/api/chat/operations/${admission.operation.id}`, "GET");
    const progressMs = Date.now() - progressStarted;
    assert.equal(before.operation.status, "RUNNING"); assert.equal(before.operation.attempts.length, 0);
    assert.equal(barrier.observation().released, false, "Provider must still be held before cancellation");
    const started = Date.now(); let cancelled = { status: null, data: null }, observationCode = null;
    try { cancelled = await request("api", `/api/chat/operations/${admission.operation.id}/cancel`, "POST", {}); }
    catch { observationCode = "HTTP_OBSERVATION_UNCONFIRMED"; }
    finally { barrier.release(); }
    const durationMs = Date.now() - started;
    const holding = barrier.observation();
    // Observe the original operation only. Never resubmit cancel, chat, or work.
    let after; const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      after = await expect(`/api/chat/operations/${admission.operation.id}`, "GET");
      if (!["QUEUED", "RUNNING"].includes(after.operation.status)) break;
      await pause(500);
    }
    assert(after && !["QUEUED", "RUNNING"].includes(after.operation.status), "Original operation did not settle");
    const repository = await open(); let original;
    try { original = await repository.readAuthoritative(state => ({ operation: structuredClone(state.chatOperations[admission.operation.id]),
      events: structuredClone(state.chatOperationEvents[admission.operation.id]), messages: structuredClone(state.chats[chat.id].messages),
      count: Object.values(state.chatOperations).filter(operation => operation.sessionId === chat.id).length })); }
    finally { await repository.close(); }
    assert.equal(original.count, 1); assert.equal(original.operation.id, admission.operation.id);
    const task = { profile: "chat-task-delivery/v1", operationId: original.operation.id, taskId: assertChatTaskOutbox(original.operation).taskId };
    const calls = fixture.calls.length, duplicate = await request("executeChatTask", "", "POST", { data: task }, false);
    assert.equal(duplicate.status, 204, duplicate.body); assert.equal(fixture.calls.length, calls, "Original delivery replayed the provider");
    const acceptedWhileInFlight = !holding.expired && [200, 202].includes(cancelled.status) && cancelled.data?.data?.cancellationRequested === true;
    const passed = acceptedWhileInFlight && original.operation.status === "CANCELLED" && original.operation.attempts.length === 0 && original.messages.length === 1;
    const report = { profile: "native-held-model-cancellation/v1", createdAt: new Date().toISOString(), passed,
      scope: "actual local Functions/Admin/encrypted Firestore + guarded Docker bridge; literal held HTTP model, no real provider/business writes/email/deployment",
      budgets: { writerAdmissionMs: 5000, fixtureHoldMs: holding.timeoutMs, providerTimeoutMs: 30_000, taskTimeoutMs: 60_000 },
      operationId: original.operation.id, progress: { status: before.operation.status, attempts: before.operation.attempts.length, durationMs: progressMs },
      cancellation: { status: cancelled.status, code: observationCode ?? cancelled.data?.meta?.code ?? null, durationMs, acceptedWhileInFlight, requestCount: 1 },
      barrier: holding, terminal: { status: original.operation.status, cancellationRequested: original.operation.cancellationRequested === true,
        attempts: original.operation.attempts.map(attempt => ({ status: attempt.status })), messages: original.messages.length, operations: original.count,
        cancellationEvents: original.events.filter(event => event.type === "operation.cancel_requested").length },
      originalTaskDuplicate: { status: duplicate.status, additionalProviderCalls: fixture.calls.length - calls },
      limit: "No artificial provider timeout enlargement; no command resend. Unknown responses are not evidence that server-side work did not happen.",
    };
    await writeFile(resolve("../docs/evidence/2026-10-12", reportName), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ passed, cancelStatus: cancelled.status, durationMs, originalStatus: original.operation.status, attempts: original.operation.attempts.length, expired: holding.expired }));
    assert(passed, "Native cancellation gate FAILED: inspect the retained held-model report; no successful cancellation is claimed");
  } finally { barrier.release(); await fixture.close(); }
}

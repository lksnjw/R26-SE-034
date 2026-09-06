import { expect, test } from "vitest";
import { stringify } from "yaml";
import { Repository, restoreState } from "../src/repository/store.js";
import { draftHistorySummary, historyPage, resolveDraftCommand, saveDraftRevision } from "../src/workflows/draft-history.js";
import { workflowContentHash } from "../src/parser/workflow.js";
import type { Workflow } from "../src/models/schemas.js";

const actor = { id: "owner", name: "Owner" };
const yaml = stringify({ name: "Saved report", trigger: { type: "manual" }, steps: [{ id: "lookup", action: "read", parameters: { enabled: false } }] });
async function fixture() {
  const state = await new Repository(null).snapshot(), now = new Date().toISOString();
  const workflow: Workflow = { id: "report", name: "Saved report", description: "", owner: actor, assignedUserIds: [], status: "PENDING", trigger: { type: "manual" }, steps: 1, successRate: 0, lastRunAt: null,
    publishedVersion: 0, draftVersion: 1, tags: [], domainTags: [], canRun: false, createdAt: now, updatedAt: now, yaml, archived: false };
  state.workflows.report = workflow; return { state, workflow };
}

test("serialized repository reopen retains exact undo/redo state and append-only snapshots", async () => {
  const { state, workflow } = await fixture(), change = { type: "updateNode" as const, nodeId: "lookup", patch: { description: "Edited label" } };
  workflow.updatedAt = "2020-01-01T00:00:00.000Z";
  const next = resolveDraftCommand(state, workflow, change); saveDraftRevision(state, workflow, next, change, actor, true);
  expect(state.versions.report![0]!.sourceUpdatedAt).toBe("2020-01-01T00:00:00.000Z");
  expect(Date.parse(String(state.versions.report![0]!.createdAt))).toBeGreaterThan(Date.parse(workflow.createdAt) - 1000);
  const saved = JSON.stringify(state), reopened = new Repository(null, restoreState(Buffer.from(saved))), restored = await reopened.snapshot(), fresh = restored.workflows.report!;
  const summary = draftHistorySummary(restored, fresh), undo = { type: "undoDraft" as const, versionId: summary.undoTarget! };
  saveDraftRevision(restored, fresh, resolveDraftCommand(restored, fresh, undo), undo, actor, true);
  expect(fresh.yaml).toBe(yaml); expect(fresh.draftVersion).toBe(3); expect(fresh.canRun).toBe(false);
  const redo = { type: "redoDraft" as const, versionId: draftHistorySummary(restored, fresh).redoTarget! };
  saveDraftRevision(restored, fresh, resolveDraftCommand(restored, fresh, redo), redo, actor, true);
  expect(fresh.yaml).toBe(next); expect(fresh.draftVersion).toBe(4);
  expect(restored.versions.report!.slice(0, 2)).toEqual(JSON.parse(saved).versions.report);
});

test("quick history is bounded without deleting older immutable revisions or their restore targets", async () => {
  const { state, workflow } = await fixture();
  for (let index = 0; index < 105; index++) {
    const command = { type: "updateNode" as const, nodeId: "lookup", patch: { description: String(index) } };
    saveDraftRevision(state, workflow, resolveDraftCommand(state, workflow, command), command, actor, true);
  }
  expect(draftHistorySummary(state, workflow).undoDepth).toBe(100); expect(state.versions.report).toHaveLength(106);
  let cursor: string | undefined, collected = 0;
  do { const page = historyPage(state, workflow, cursor); expect(page.entries.length).toBeLessThanOrEqual(20); collected += page.entries.length; cursor = page.nextBeforeId ? String(page.nextBeforeId) : undefined; } while (cursor);
  expect(collected).toBe(106);
  const baseline = state.versions.report![0]!, command = { type: "restoreVersion" as const, versionId: String(baseline.id), contentHash: workflowContentHash(yaml) };
  saveDraftRevision(state, workflow, resolveDraftCommand(state, workflow, command), command, actor, true);
  expect(workflow.yaml).toBe(yaml); expect(state.versions.report).toHaveLength(107);
});

test.each(["profile", "extra", "reference", "head", "hash"])("corrupt saved %s cannot become undo authority", async kind => {
  const { state, workflow } = await fixture(), command = { type: "updateNode" as const, nodeId: "lookup", patch: { description: "Edited" } };
  saveDraftRevision(state, workflow, resolveDraftCommand(state, workflow, command), command, actor, true);
  const latest = state.versions.report!.at(-1)!, history = latest.editHistory as any;
  if (kind === "profile") history.profile = "unsupported";
  if (kind === "extra") history.approved = true;
  if (kind === "reference") history.undo[0].versionId = "missing";
  if (kind === "head") latest.yaml = yaml;
  if (kind === "hash") latest.contentHash = workflowContentHash(yaml);
  expect(() => draftHistorySummary(state, workflow)).toThrow(/needs repair/);
});

test("a blocked draft remains blocked when restored, without borrowing publication readiness", async () => {
  const { state, workflow } = await fixture(), change = { type: "updateNode" as const, nodeId: "lookup", patch: { action: "unsupported" } };
  const blocked = saveDraftRevision(state, workflow, resolveDraftCommand(state, workflow, change), change, actor, false);
  const undo = { type: "undoDraft" as const, versionId: draftHistorySummary(state, workflow).undoTarget! };
  saveDraftRevision(state, workflow, resolveDraftCommand(state, workflow, undo), undo, actor, true);
  const restore = { type: "restoreVersion" as const, versionId: blocked.id, contentHash: blocked.contentHash };
  saveDraftRevision(state, workflow, resolveDraftCommand(state, workflow, restore), restore, actor, false);
  expect(workflow.status).toBe("draft-unvalidated"); expect(workflow.canRun).toBe(false); expect(workflow.publishedVersion).toBe(0);
});

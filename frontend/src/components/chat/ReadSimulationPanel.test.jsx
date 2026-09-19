/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ReadSimulationPanel from "./ReadSimulationPanel";
import { workflowService } from "../../services/workflow.service";

const record = { version: 1, contentHash: `sha256:${"a".repeat(64)}`, authoring: { profile: "read-authoring/v1", registryHash: "registry-a", inputSchema: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"], additionalProperties: false }, nodes: [{ nodeId: "read", outputSchema: { type: "object", properties: { id: { type: "string" }, api_token: { type: "string", writeOnly: true } }, required: ["id"], additionalProperties: false } }] } };
const steps = [{ id: "read" }];
const response = (extra = {}) => ({ simulation: "fixture-read/v1", dry_run: true, can_execute: false, erp_calls: 0, model_calls: 0, persisted_run: false, live_readiness: "not_checked", runtime_authorization: "not_checked", capability_admission: "not_checked", workflowId: "flow", baseVersion: 1, baseHash: record.contentHash, registryHash: "registry-a", outcome: "SIMULATED_COMPLETE", trace: [{ nodeId: "gate", kind: "condition", outcome: "SIMULATED_DECISION", selectedBranch: "then" }, { nodeId: "read", kind: "action", outcome: "SIMULATED", arguments: { id: "input" }, output: { content: [], structuredContent: { id: "supplied" } } }], finalOutput: false, unusedFixtureIds: ["unused"], ...extra });
beforeEach(() => { jest.spyOn(workflowService, "simulate").mockResolvedValue(response()); jest.spyOn(workflowService, "run").mockResolvedValue({}); jest.spyOn(workflowService, "publish").mockResolvedValue({}); });
afterEach(() => { cleanup(); jest.restoreAllMocks(); sessionStorage.clear(); localStorage.clear(); });
const open = (extra = {}) => render(<ReadSimulationPanel workflowId="flow" record={record} steps={steps} canControl {...extra} />);
const evaluate = () => fireEvent.click(screen.getByRole("button", { name: "Evaluate simulation" }));

const modelStep = kind => ({ id: "answer", kind, output_schema: { type: "object", properties: { summary: { type: "string" }, complete: { type: "boolean" } }, required: ["summary", "complete"], additionalProperties: false } });
const modelResponse = extra => response({ simulation: "fixture-model/v1", approval: "not_granted", model_behavior: "not_tested", model_usage: "not_measured", agent_tool_calls: "not_simulated",
  trace: [{ nodeId: "answer", kind: "analysis", outcome: "SUPPLIED_MODEL_OUTPUT", arguments: { invoices: [1], orders: [2] }, output: { structuredContent: { summary: "Supplied comparison", complete: true } } }], ...extra });
test.each(["analysis", "agent"])("%s forms submit only schema fields and label supplied model answers without live authority", async kind => {
  workflowService.simulate.mockResolvedValue(modelResponse({ trace: [{ nodeId: "answer", kind, outcome: "SUPPLIED_MODEL_OUTPUT", output: { structuredContent: { summary: "Supplied comparison", complete: true } } }] }));
  open({ steps: [modelStep(kind)] });
  fireEvent.click(screen.getByLabelText("Supply response for answer"));
  fireEvent.click(screen.getByRole("button", { name: "Set summary", exact: true }));
  fireEvent.change(screen.getByLabelText("answer test output · summary"), { target: { value: "Supplied comparison" } });
  fireEvent.click(screen.getByRole("button", { name: "Set complete", exact: true }));
  fireEvent.change(screen.getByLabelText("answer test output · complete"), { target: { value: "true" } });
  expect(screen.queryByLabelText("answer test response text")).toBeNull(); expect(screen.queryByLabelText("answer test tool error")).toBeNull();
  evaluate(); const result = await screen.findByRole("region", { name: "Simulation results" });
  expect(workflowService.simulate).toHaveBeenCalledWith("flow", record, {}, { answer: { structuredContent: { summary: "Supplied comparison", complete: true } } }, "model-fixtures/v1");
  expect(result.textContent).toContain("Supplied structured model answer accepted"); expect(result.textContent).toContain("not a real execution receipt");
  expect(workflowService.run).not.toHaveBeenCalled(); expect(workflowService.publish).not.toHaveBeenCalled();
});
test.each([{ model_behavior: "tested" }, { model_usage: "measured" }, { agent_tool_calls: 1 }, { approval: "granted" }, { tokens: { total: 5 } }, { simulation: "fixture-read/v1" }])("model fixture result rejects fabricated runtime proof %j", async change => {
  workflowService.simulate.mockResolvedValue(modelResponse(change)); open({ steps: [modelStep("analysis")] }); evaluate();
  await screen.findByRole("alert"); expect(screen.queryByRole("region", { name: "Simulation results" })).toBeNull();
});
test("model stop retains readable prior answers and never invents agent completion", async () => {
  workflowService.simulate.mockResolvedValue(modelResponse({ outcome: "SIMULATED_STOPPED", reason: "FIXTURE_AGENT_INCOMPLETE", trace: [{ nodeId: "answer", kind: "agent", outcome: "FIXTURE_AGENT_INCOMPLETE" }] }));
  open({ steps: [modelStep("agent")] }); evaluate(); const result = await screen.findByRole("region", { name: "Simulation results" });
  expect(result.textContent).toContain("Supplied agent answer does not meet its completion predicate"); expect(result.textContent).toContain("incomplete");
});

const loopRecord = { ...record, authoring: { ...record.authoring, executionProfile: "collection-simulation-only", controlFlow: { kind: "sequence", nodes: [{ kind: "foreach", id: "each", maxItems: 3, body: { kind: "sequence", nodes: [{ kind: "action", nodeId: "read" }] } }] } } };
const loopResponse = change => response({ simulation: "fixture-read/v2", trace: [{ nodeId: "each", kind: "collection", outcome: "SIMULATED_COLLECTION_STARTED", count: 2, invocationId: "each", iterations: [] }, { nodeId: "read", kind: "action", outcome: "SIMULATED", invocationId: "each/0/read", iterations: [{ loopId: "each", index: 0 }], output: { content: [{ type: "text", text: "First supplied answer" }] } }, { nodeId: "read", kind: "action", outcome: "SIMULATED", invocationId: "each/1/read", iterations: [{ loopId: "each", index: 1 }], output: { content: [{ type: "text", text: "Second supplied answer" }] } }], finalOutput: ["First", "Second"], unusedFixtureIds: [], ...change });
test("collection forms submit explicit per-item fixtures and display separate readable answers, never a shared node fixture", async () => {
  workflowService.simulate.mockResolvedValue(loopResponse()); open({ record: loopRecord });
  expect(screen.queryByLabelText("Supply response for read")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add item response for read" })); fireEvent.change(screen.getByLabelText("each/0/read test response text"), { target: { value: "First" } });
  fireEvent.change(screen.getByLabelText("read each fixture item number"), { target: { value: "2" } }); fireEvent.click(screen.getByRole("button", { name: "Add item response for read" })); fireEvent.change(screen.getByLabelText("each/1/read test response text"), { target: { value: "Second" } }); evaluate();
  const results = await screen.findByRole("region", { name: "Simulation results" });
  expect(workflowService.simulate).toHaveBeenCalledWith("flow", loopRecord, {}, { "each/0/read": { content: [{ type: "text", text: "First" }] }, "each/1/read": { content: [{ type: "text", text: "Second" }] } }, "read-fixtures/v2");
  expect(within(results).getByText("each · item 1")).toBeTruthy(); expect(within(results).getByText("each · item 2")).toBeTruthy(); expect(results.textContent).toContain("First supplied answer"); expect(results.textContent).toContain("Second supplied answer"); expect(results.querySelector("pre")).toBeNull(); expect(workflowService.run).not.toHaveBeenCalled();
});
test.each([{ simulation: "fixture-read/v1" }, { trace: [{ nodeId: "read", kind: "action", outcome: "SIMULATED", invocationId: "each/0/read", iterations: [{ loopId: "each", index: 1 }] }] }, { trace: [{ nodeId: "read", kind: "action", outcome: "SIMULATED", invocationId: "each/100/read", iterations: [{ loopId: "each", index: 100 }] }] }, { trace: [{ nodeId: "read", kind: "action", outcome: "SIMULATED" }] }])("collection result rejects unverified iteration identity %j", async change => {
  workflowService.simulate.mockResolvedValue(loopResponse(change)); open({ record: loopRecord }); evaluate(); await screen.findByRole("alert"); expect(screen.queryByRole("region", { name: "Simulation results" })).toBeNull();
});

test("structured fixture forms require explicit supply and never publish, execute or store test data", async () => {
  const view = open(); fireEvent.click(screen.getByRole("button", { name: "Set enabled" }));
  fireEvent.change(screen.getByLabelText("Simulation inputs · enabled"), { target: { value: "true" } });
  fireEvent.click(screen.getByLabelText("Supply response for read")); fireEvent.click(screen.getByLabelText("read structured test data"));
  fireEvent.click(screen.getByRole("button", { name: "Set id" })); fireEvent.change(screen.getByLabelText("read test output · id"), { target: { value: "fixture-id" } });
  fireEvent.click(screen.getByRole("button", { name: "Set api_token" })); expect(screen.getByLabelText("read test output · api_token").type).toBe("password");
  fireEvent.click(screen.getByLabelText("read test tool error")); evaluate();
  await screen.findByRole("region", { name: "Simulation results" });
  expect(workflowService.simulate).toHaveBeenCalledWith("flow", record, { enabled: true }, { read: { content: [], structuredContent: { id: "fixture-id", api_token: "" }, isError: true } });
  expect(workflowService.run).not.toHaveBeenCalled(); expect(workflowService.publish).not.toHaveBeenCalled(); expect(sessionStorage.length).toBe(0); expect(localStorage.length).toBe(0); expect(view.container.querySelector("pre")).toBeNull();
  const results = screen.getByRole("region", { name: "Simulation results" }); expect(within(results).getByText("No")).toBeTruthy(); expect(results.textContent).toContain("Test data · not a real execution receipt"); expect(results.textContent).toContain("Unused supplied responses · unused");
});

test("missing fixtures stay missing; simulation never invents a response", async () => {
  workflowService.simulate.mockResolvedValue(response({ outcome: "SIMULATED_STOPPED", reason: "MISSING_FIXTURE", trace: [{ nodeId: "read", kind: "action", outcome: "MISSING_FIXTURE" }], finalOutput: undefined }));
  open(); evaluate(); await screen.findByText("Simulation stopped · draft v1"); expect(workflowService.simulate).toHaveBeenCalledWith("flow", record, {}, {}); expect(screen.queryByText("Supplied response accepted")).toBeNull();
});

test.each([0, null, false])("simulated final value %j remains explicitly distinguishable", async finalOutput => {
  workflowService.simulate.mockResolvedValue(response({ finalOutput })); open(); evaluate(); const results = await screen.findByRole("region", { name: "Simulation results" });
  expect(results.textContent).toContain(finalOutput === null ? "Explicit null" : finalOutput === false ? "No" : "0");
});

test.each([{ id: "real-run" }, { erp_calls: 1 }, { persisted_run: true }, { can_execute: true }, { baseVersion: 2 }, { baseHash: "other" }, { registryHash: "changed" }, { simulation: "static-read-plan" }, { outcome: "DONE" }, { live_readiness: "ready" }, { trace: [{ kind: "action", outcome: "DONE" }] }])("unverified simulation envelope %j is rejected", async change => {
  workflowService.simulate.mockResolvedValue(response(change)); open(); evaluate(); await screen.findByRole("alert"); expect(screen.queryByRole("region", { name: "Simulation results" })).toBeNull(); expect(workflowService.run).not.toHaveBeenCalled();
});

test("read-only/unknown draft controls do not submit fixtures", () => {
  const view = open({ canControl: false }); expect(screen.queryByRole("button", { name: "Evaluate simulation" })).toBeNull();
  view.rerender(<ReadSimulationPanel workflowId="flow" record={record} steps={steps} canControl disabled />); evaluate(); expect(workflowService.simulate).not.toHaveBeenCalled();
});

test("duplicate submissions are disabled and timeout retains fixtures without automatic retry", async () => {
  let reject; workflowService.simulate.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; })); open();
  fireEvent.click(screen.getByLabelText("Supply response for read")); fireEvent.change(screen.getByLabelText("read test response text"), { target: { value: "Keep test text" } });
  evaluate(); expect(screen.getByRole("button", { name: "Evaluating test data…" }).disabled).toBe(true);
  reject(new Error("Timed out")); await screen.findByRole("alert"); expect(screen.getByLabelText("read test response text").value).toBe("Keep test text"); expect(workflowService.simulate).toHaveBeenCalledTimes(1);
});

test("changing fixtures clears old results and a revision change discards stale fixtures/results", async () => {
  const view = open(); fireEvent.click(screen.getByLabelText("Supply response for read")); evaluate(); await screen.findByRole("region", { name: "Simulation results" });
  fireEvent.change(screen.getByLabelText("read test response text"), { target: { value: "new test" } }); expect(screen.queryByRole("region", { name: "Simulation results" })).toBeNull();
  view.rerender(<ReadSimulationPanel workflowId="flow" record={{ ...record, version: 2 }} steps={steps} canControl />); expect(screen.getByLabelText("Supply response for read").checked).toBe(false); expect(screen.queryByRole("region", { name: "Simulation results" })).toBeNull();
});

test("permission revocation discards pending simulation output", async () => {
  let resolve; workflowService.simulate.mockReturnValue(new Promise(done => { resolve = done; })); const view = open(); evaluate();
  view.rerender(<ReadSimulationPanel workflowId="flow" record={record} steps={steps} canControl={false} />); resolve(response());
  await waitFor(() => expect(screen.queryByRole("region", { name: "Simulation results" })).toBeNull());
});

/** @jest-environment jsdom */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

const catalog = jest.fn(), discover = jest.fn(), review = jest.fn(), disable = jest.fn();
let role = "Platform Admin", permissions = new Set(["registry:read", "registry:write"]);
jest.unstable_mockModule("../../hooks/usePermissions", () => ({ usePermissions: () => ({ actorId: "admin-fixture", role, has: (value) => permissions.has(value) }) }));
jest.unstable_mockModule("../../services/capability.service", () => ({ capabilityService: { catalog, discover, review, disable } }));
const { default: Panel } = await import("./CapabilityReviewPanel.jsx");
const entry = () => ({ capabilityId: "cap-fixture", effectiveState: "REVIEW_REQUIRED", reviewEligible: true, reviewReason: null, admission: null, revision: null,
  observation: { id: "obs-fixture", toolId: "TOOL-1", contractHash: `sha256:${"a".repeat(64)}`, discoveredAt: "2026-10-05T01:00:00.000Z",
    definition: { display_name: "Read invoices", name: "erp.invoices", input_schema: { type: "object", properties: { customer: { type: "string" } } }, allowed_roles: ["Workflow Builder"],
      is_read_only: true, bridge_contract: { resource_version: "1.0.0", resource_digest: "b".repeat(64), output_schema: { type: "object", properties: { total: { type: "number" } } } } } } });
const page = (value = entry(), overrides = {}) => ({ capabilities: [value], persistence: "durable-single-writer", connection: { state: "INITIALIZED_NOT_QUALIFIED", discoveryAvailable: true }, offset: 0, limit: 10, hasMoreCapabilities: false, ...overrides });
let clients = [];
function mount() { const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } }); clients.push(client); return render(<QueryClientProvider client={client}><Panel /></QueryClientProvider>); }
async function select() { fireEvent.click(await screen.findByRole("button", { name: /Read invoices/ })); }
function confirm() { fireEvent.change(screen.getByLabelText("Capability decision note"), { target: { value: "Exact read contract reviewed" } }); fireEvent.click(screen.getByRole("checkbox")); }
beforeEach(() => { sessionStorage.clear(); catalog.mockResolvedValue(page()); role = "Platform Admin"; permissions = new Set(["registry:read", "registry:write"]); });
afterEach(() => { cleanup(); for (const client of clients) client.clear(); clients = []; for (const mock of [catalog, discover, review, disable]) mock.mockReset(); jest.restoreAllMocks(); });

test("formatted inspection requires a note and explicit confirmation; discovery cannot auto-review", async () => {
  mount(); await select();
  expect(screen.getByText("Customer")).not.toBeNull(); expect(screen.getByText("Total")).not.toBeNull(); expect(screen.getByText("Workflow Builder")).not.toBeNull();
  expect(document.querySelector("pre")).toBeNull(); expect(screen.getByRole("button", { name: "Save explicit read review" }).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Capability decision note"), { target: { value: "Review" } });
  expect(screen.getByRole("button", { name: "Save explicit read review" }).disabled).toBe(true);
  discover.mockResolvedValue({ authorityGranted: false, blockedCount: 1, unreviewedInventory: [{ remoteName: "erp.unmapped", reason: "NO_LOCAL_REVIEW_CONTRACT" }] });
  fireEvent.click(screen.getByRole("button", { name: "Refresh discovery" }));
  expect(await screen.findByText(/Discovery saved; no tool enabled/)).not.toBeNull(); expect(screen.getByText(/erp.unmapped/)).not.toBeNull(); expect(review).not.toHaveBeenCalled();
});

test("a report coverage read explains its exact interval and completeness evidence before review", async () => {
  const value = entry(); value.observation.definition.report_coverage_contract = { profile: "report-coverage/v1", start_parameter: "startAt", end_parameter: "endAt",
    covered_start_path: ["coveredStartAt"], covered_end_path: ["coveredEndAt"], complete_path: ["complete"], has_more_path: ["hasMore"], items_path: ["items"], item_count_path: ["itemCount"],
    key_projection: { profile: "report-key-projection/v1", relation_name: "invoice-orders", item_key_path: ["orderId"], keys_path: ["orderIds"] } };
  catalog.mockResolvedValue(page(value)); mount(); await select();
  expect(screen.getByText("Scheduled report coverage")).toBeTruthy(); expect(screen.getByText(/Exact startAt → endAt interval/)).toBeTruthy();
  expect(screen.getByText(/identifies the complete/).textContent).toMatch(/invoice-orders/);
  expect(screen.getByText(/does not approve a later effect/i)).toBeTruthy(); expect(document.querySelector("pre")).toBeNull();
});

test("lost acknowledgement retains exact decision across remount and duplicate disabled receipt does not display enabled success", async () => {
  const first = mount(); await select(); confirm(); review.mockRejectedValueOnce(new Error("ACK lost"));
  fireEvent.click(screen.getByRole("button", { name: "Save explicit read review" }));
  await screen.findByText("Unconfirmed review decision"); await waitFor(() => expect(screen.getByRole("button", { name: "Retry exact decision" }).disabled).toBe(false));
  const request = review.mock.calls[0]; expect(request[1]).toMatchObject({ observationId: "obs-fixture", effectClass: "read", riskClass: "low", dataClass: "internal", retryPolicy: "never" });
  expect(request[1].decisionKey).toMatch(/^review_/); first.unmount(); mount();
  review.mockResolvedValueOnce({ duplicate: true, revision: { capabilityId: "cap-fixture", observationId: "obs-fixture", contractHash: entry().observation.contractHash }, admission: { capabilityId: "cap-fixture", state: "DISABLED", version: 2 } });
  fireEvent.click(await screen.findByRole("button", { name: "Retry exact decision" }));
  await waitFor(() => expect(review).toHaveBeenCalledTimes(2)); expect(review.mock.calls[1]).toEqual(request);
  expect(await screen.findByText(/Review decision acknowledged/)).not.toBeNull(); expect(sessionStorage.getItem("workflow.capability-decision.admin-fixture")).toBeNull();
  expect(screen.queryByText(/tool enabled/i)).toBeNull();
});

test("missing administrator role, read permission or supported storage cannot grant", async () => {
  role = "Workflow Builder"; mount(); await select(); expect(screen.queryByRole("button", { name: "Save explicit read review" })).toBeNull();
  cleanup(); role = "Platform Admin"; catalog.mockResolvedValue(page(entry(), { persistence: "unsupported-for-admission" })); mount(); await select();
  expect(screen.queryByRole("button", { name: "Save explicit read review" })).toBeNull();
  cleanup(); permissions = new Set(["registry:write"]); mount(); expect(screen.queryByText("ERP capability review")).toBeNull(); expect(review).not.toHaveBeenCalled();
});

test("stale/unsupported contracts and incomplete inspection disable new reviews", async () => {
  const value = entry(); value.reviewEligible = false; value.reviewReason = "OBSERVATION_STALE"; catalog.mockResolvedValue(page(value)); mount(); await select(); confirm();
  expect(screen.getByText("Observation stale")).not.toBeNull(); expect(screen.getByRole("button", { name: "Save explicit read review" }).disabled).toBe(true);
  cleanup(); const complex = entry(); complex.observation.definition.input_schema.properties = Object.fromEntries(Array.from({ length: 61 }, (_, index) => [`field${index}`, { type: "string" }])); catalog.mockResolvedValue(page(complex)); mount(); await select(); confirm();
  expect(screen.getByText(/exceeds the readable inspector budget/)).not.toBeNull(); expect(screen.getByRole("button", { name: "Save explicit read review" }).disabled).toBe(true);
});

test("local decision storage failure does not submit an untracked request", async () => {
  mount(); await select(); confirm(); jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("storage unavailable"); });
  fireEvent.click(screen.getByRole("button", { name: "Save explicit read review" })); await screen.findByRole("alert"); expect(review).not.toHaveBeenCalled();
});

test("disable sends exact revision/version and leaves already-sent work rollback unclaimed", async () => {
  const value = entry(); value.effectiveState = "AVAILABLE"; value.admission = { revisionId: "rev-current", version: 7, state: "AVAILABLE" }; catalog.mockResolvedValue(page(value));
  disable.mockResolvedValue({ capabilityId: "cap-fixture", revisionId: "rev-current", version: 8, state: "DISABLED" }); mount(); await select(); confirm();
  fireEvent.click(screen.getByRole("button", { name: "Disable new dispatch" })); expect(await screen.findByText(/already-sent remote work is not rolled back/)).not.toBeNull();
  expect(disable).toHaveBeenCalledWith("cap-fixture", { revisionId: "rev-current", baseVersion: 7, note: "Exact read contract reviewed" });
});

test("invalid receipt retains pending request and status failure disables new decisions", async () => {
  review.mockResolvedValue({ admission: { capabilityId: "wrong", state: "AVAILABLE", version: 1 } }); mount(); await select(); confirm();
  fireEvent.click(screen.getByRole("button", { name: "Save explicit read review" })); expect(await screen.findByText("Unconfirmed review decision")).not.toBeNull(); await screen.findByRole("alert");
  expect(sessionStorage.getItem("workflow.capability-decision.admin-fixture")).not.toBeNull();
  cleanup(); sessionStorage.clear(); catalog.mockRejectedValue(new Error("backend unavailable")); mount();
  expect(await screen.findByText(/Review status unavailable/)).not.toBeNull(); expect(screen.getByRole("button", { name: "Refresh discovery" }).disabled).toBe(true);
});

test("pagination is bounded and clears the inspector; corrupted retry records require explicit recovery", async () => {
  catalog.mockResolvedValue(page(entry(), { hasMoreCapabilities: true })); mount(); await select(); fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(catalog).toHaveBeenCalledWith(10)); expect(screen.queryByLabelText("Capability decision note")).toBeNull();
  cleanup(); sessionStorage.setItem("workflow.capability-decision.admin-fixture", "invalid"); mount();
  expect(await screen.findByText("The local decision record needs recovery.")).not.toBeNull(); expect(screen.queryByRole("button", { name: "Retry exact decision" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reload status and end local retries" })); expect(await screen.findByText(/Local retries ended/)).not.toBeNull(); expect(sessionStorage.length).toBe(0);
});

test("operation review preserves the observed effect/risk and mandatory independent approval across an uncertain remount", async () => {
  const value = entry(), definition = value.observation.definition;
  definition.display_name = "Send invoice report"; definition.is_read_only = false; definition.risk_level = "medium";
  definition.operation_contract = { profile: "operation-result/v1", effect_class: "notification", retry_policy: "never", confirmation: { path: ["accepted"], expected: true, meaning: "operation-accepted" } };
  catalog.mockResolvedValue(page(value)); review.mockRejectedValueOnce(new Error("Lost operation review acknowledgement"));
  const first = mount(); fireEvent.click(await screen.findByRole("button", { name: /Send invoice report/ }));
  expect(screen.getByText(/independent approval required for every invocation/)).toBeTruthy();
  expect(screen.getByText(/This review does not authorize a particular send or ERP change/)).toBeTruthy();
  confirm(); fireEvent.click(screen.getByRole("button", { name: "Save explicit operation review" }));
  await screen.findByText("Unconfirmed review decision"); const request = review.mock.calls[0];
  expect(request[1]).toMatchObject({ effectClass: "notification", riskClass: "medium", requireIndependentApproval: true, retryPolicy: "never" });
  first.unmount(); mount(); review.mockRejectedValueOnce(new Error("Still unconfirmed"));
  fireEvent.click(await screen.findByRole("button", { name: "Retry exact decision" }));
  await waitFor(() => expect(review).toHaveBeenCalledTimes(2)); expect(review.mock.calls[1]).toEqual(request);
  expect(screen.queryByText("The local decision record needs recovery.")).toBeNull();
});

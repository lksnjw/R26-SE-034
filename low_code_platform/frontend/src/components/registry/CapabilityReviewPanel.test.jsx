/** @jest-environment jsdom */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

const catalog = jest.fn(), discover = jest.fn(), review = jest.fn(), disable = jest.fn(), importReview = jest.fn();
let role = "Platform Admin", permissions = new Set(["registry:read", "registry:write"]);
jest.unstable_mockModule("../../hooks/usePermissions", () => ({ usePermissions: () => ({ actorId: "admin-fixture", role, has: (value) => permissions.has(value) }) }));
jest.unstable_mockModule("../../services/capability.service", () => ({ capabilityService: { catalog, discover, review, disable, import: importReview } }));
const { default: Panel } = await import("./CapabilityReviewPanel.jsx");
const entry = () => ({ capabilityId: "cap-fixture", effectiveState: "REVIEW_REQUIRED", reviewEligible: true, reviewReason: null, admission: null, revision: null,
  observation: { id: "obs-fixture", connectionId: "finance", toolId: "TOOL-1", contractHash: `sha256:${"a".repeat(64)}`, discoveredAt: "2026-10-05T01:00:00.000Z",
    definition: { display_name: "Read invoices", name: "erp.invoices", input_schema: { type: "object", properties: { customer: { type: "string" } } }, allowed_roles: ["Workflow Builder"],
      is_read_only: true, bridge_contract: { resource_version: "1.0.0", resource_digest: "b".repeat(64), output_schema: { type: "object", properties: { total: { type: "number" } } } } } } });
const page = (value = entry(), overrides = {}) => ({ capabilities: [value], persistence: "durable-single-writer", connection: { id: "finance", state: "INITIALIZED_NOT_QUALIFIED", discoveryAvailable: true },
  connections: [{ id: "finance", primary: true, dispatchSupported: true }], offset: 0, limit: 10, hasMoreCapabilities: false, ...overrides });
let clients = [];
function mount() { const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } }); clients.push(client); return render(<QueryClientProvider client={client}><Panel /></QueryClientProvider>); }
async function select() { fireEvent.click(await screen.findByRole("button", { name: /Read invoices/ })); }
function confirm() { const sensitivity = screen.getByRole("combobox", { name: "Reviewed data sensitivity" }); if (!sensitivity.value) fireEvent.change(sensitivity, { target: { value: "internal" } }); fireEvent.change(screen.getByLabelText("Capability decision note"), { target: { value: "Exact read contract reviewed" } }); fireEvent.click(screen.getByRole("checkbox")); }
const remoteItem = () => ({ remoteName: "unknown.lookup.rev_MS4wLjA", remoteHash: `sha256:${"d".repeat(64)}`, importable: true, reason: "NO_LOCAL_REVIEW_CONTRACT", authorityGranted: false,
  definition: { name: "discovered.finance.lookup_abc", display_name: "New Department lookup", mcp_tool_name: "unknown.lookup", connection_id: "finance", description: "Untrusted tool description",
    input_schema: { type: "object", properties: {} }, bridge_contract: { resource_version: "1.0.0", remote_roles: [], output_schema: { type: "object", properties: { count: { type: "integer" } } } } } });
function importReceipt(body) { return { remoteHash: body.remoteHash, admission: { capabilityId: "cap-new", state: "AVAILABLE", version: 1 },
  revision: { capabilityId: "cap-new", connectionId: "finance", definition: { ...remoteItem().definition, allowed_roles: body.allowedRoles, is_read_only: true, risk_level: "low", side_effects: [] },
    policy: { effectClass: body.effectClass, riskClass: body.riskClass, dataClass: body.dataClass, retryPolicy: body.retryPolicy, note: body.note } } }; }
async function openImport() {
  catalog.mockResolvedValue(page(entry(), { roleOptions: [{ id: "admin", name: "Platform Admin" }] }));
  discover.mockResolvedValue({ connectionId: "finance", authorityGranted: false, blockedCount: 0, unreviewedInventory: [remoteItem()] });
  const view = mount(), refresh = await screen.findByRole("button", { name: "Refresh discovery" });
  await waitFor(() => expect(refresh.disabled).toBe(false)); fireEvent.click(refresh);
  await screen.findByText(/Discovery saved; no tool enabled/); fireEvent.click(screen.getByText("Unmapped remote tools (1)"));
  fireEvent.click(await screen.findByRole("button", { name: `Inspect New Department lookup · ${remoteItem().remoteName}` }));
  fireEvent.change(screen.getByLabelText("Discovered tool effect"), { target: { value: "read" } });
  fireEvent.change(screen.getByLabelText("Discovered tool sensitivity"), { target: { value: "internal" } });
  fireEvent.click(screen.getByLabelText("Platform Admin"));
  fireEvent.change(screen.getByLabelText("Discovered tool review note"), { target: { value: "Explicit new contract review" } });
  fireEvent.click(screen.getByLabelText("Confirm discovered contract review")); return view;
}
test("new discovery review uses the selected connection and clears only an exact acknowledged request", async () => {
  importReview.mockImplementationOnce(async (_id, body) => importReceipt(body)); await openImport();
  fireEvent.click(screen.getByRole("button", { name: "Review and add tool" }));
  await screen.findByText(/Discovered-tool review acknowledged/); expect(importReview).toHaveBeenCalledTimes(1);
  expect(importReview.mock.calls[0]).toEqual([remoteItem().remoteName, expect.objectContaining({ remoteHash: remoteItem().remoteHash, allowedRoles: ["Platform Admin"], confirmed: true, effectClass: "read" }), "finance"]);
  expect(sessionStorage.length).toBe(0); expect(review).not.toHaveBeenCalled();
});

test("same friendly names retain distinct exact selectors and identify an unpinned alias before inspection", async () => {
  const exact = remoteItem(), alias = { ...remoteItem(), remoteName: "unknown.lookup", importable: false,
    definition: { ...remoteItem().definition, bridge_contract: undefined } };
  discover.mockResolvedValue({ connectionId: "finance", authorityGranted: false, blockedCount: 0, unreviewedInventory: [alias, exact] });
  mount(); const refresh = await screen.findByRole("button", { name: "Refresh discovery" });
  await waitFor(() => expect(refresh.disabled).toBe(false)); fireEvent.click(refresh);
  await screen.findByText(/Discovery saved; no tool enabled/); fireEvent.click(screen.getByText("Unmapped remote tools (2)"));
  expect(screen.getByText("Version not pinned · Not eligible for import")).toBeTruthy();
  expect(screen.getByText("Version 1.0.0")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Inspect New Department lookup · unknown.lookup", exact: true })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: `Inspect New Department lookup · ${exact.remoteName}`, exact: true }));
  expect(screen.getByRole("form", { name: "Review discovered tool" })).toBeTruthy();
  expect(importReview).not.toHaveBeenCalled();
});
test("unconfirmed import survives remount and retries the original exact decision, not a fresh review key", async () => {
  importReview.mockRejectedValueOnce(new Error("Acknowledgement unknown")); const view = await openImport();
  fireEvent.click(screen.getByRole("button", { name: "Review and add tool" })); await screen.findByRole("alert");
  const original = importReview.mock.calls[0]; expect(sessionStorage.length).toBe(1); view.unmount(); mount();
  const retry = await screen.findByRole("button", { name: "Retry exact decision" });
  importReview.mockImplementationOnce(async (_id, body) => importReceipt(body)); fireEvent.click(retry);
  await screen.findByText(/Discovered-tool review acknowledged/); expect(importReview.mock.calls[1]).toEqual(original); expect(sessionStorage.length).toBe(0);
});
test("mismatched import acknowledgement remains unconfirmed and cannot enable a tool from a success label", async () => {
  importReview.mockImplementationOnce(async (_id, body) => ({ ...importReceipt(body), remoteHash: `sha256:${"e".repeat(64)}` })); await openImport();
  fireEvent.click(screen.getByRole("button", { name: "Review and add tool" })); await screen.findByRole("alert");
  expect(screen.getByText("Unconfirmed import decision")).not.toBeNull(); expect(sessionStorage.length).toBe(1);
  expect(screen.queryByText(/Discovered-tool review acknowledged/)).toBeNull();
});
beforeEach(() => { sessionStorage.clear(); catalog.mockResolvedValue(page()); role = "Platform Admin"; permissions = new Set(["registry:read", "registry:write"]); });
afterEach(() => { cleanup(); for (const client of clients) client.clear(); clients = []; for (const mock of [catalog, discover, review, disable, importReview]) mock.mockReset(); jest.restoreAllMocks(); });

test("formatted inspection requires a note and explicit confirmation; discovery cannot auto-review", async () => {
  mount(); await select();
  expect(screen.getByText("Customer")).not.toBeNull(); expect(screen.getByText("Total")).not.toBeNull(); expect(screen.getByText("Workflow Builder")).not.toBeNull();
  expect(document.querySelector("pre")).toBeNull(); expect(screen.getByRole("button", { name: "Save explicit read review" }).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Capability decision note"), { target: { value: "Review" } });
  expect(screen.getByRole("button", { name: "Save explicit read review" }).disabled).toBe(true);
  discover.mockResolvedValue({ connectionId: "finance", authorityGranted: false, blockedCount: 1, unreviewedInventory: [{ remoteName: "erp.unmapped", reason: "NO_LOCAL_REVIEW_CONTRACT" }] });
  fireEvent.click(screen.getByRole("button", { name: "Refresh discovery" }));
  expect(await screen.findByText(/Discovery saved; no tool enabled/)).not.toBeNull(); expect(screen.getByText(/erp.unmapped/)).not.toBeNull(); expect(review).not.toHaveBeenCalled();
});

test("new read review requires an explicit sensitivity choice and changing it resets confirmation", async () => {
  mount(); await select();
  const sensitivity = screen.getByRole("combobox", { name: "Reviewed data sensitivity" });
  expect(sensitivity.value).toBe(""); expect(Array.from(sensitivity.options).map(option => option.value)).toEqual(["", "public", "internal", "confidential", "restricted"]);
  fireEvent.change(screen.getByLabelText("Capability decision note"), { target: { value: "Reviewed invoice data" } }); fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: "Save explicit read review" }).disabled).toBe(true);
  fireEvent.change(sensitivity, { target: { value: "confidential" } });
  expect(screen.getByRole("checkbox").checked).toBe(false); expect(screen.getByText(/Sensitive business or personal information/)).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox")); expect(screen.getByRole("button", { name: "Save explicit read review" }).disabled).toBe(false);
  fireEvent.change(sensitivity, { target: { value: "restricted" } }); expect(screen.getByRole("checkbox").checked).toBe(false);
  expect(screen.getByText(/Separate provider egress review is still required/)).toBeTruthy(); expect(review).not.toHaveBeenCalled();
});

test.each(["public", "internal", "confidential", "restricted"])("%s read decision survives remount and exact acknowledgement retry", async dataClass => {
  const first = mount(); await select();
  fireEvent.change(screen.getByRole("combobox", { name: "Reviewed data sensitivity" }), { target: { value: dataClass } }); confirm();
  review.mockRejectedValueOnce(new Error("Unconfirmed synthetic receipt")); fireEvent.click(screen.getByRole("button", { name: "Save explicit read review" }));
  await screen.findByText("Unconfirmed review decision");
  const request = review.mock.calls[0]; expect(request[1].dataClass).toBe(dataClass);
  expect(screen.getByText(/Requested data sensitivity/).textContent).toContain(dataClass[0].toUpperCase() + dataClass.slice(1));
  first.unmount(); mount();
  review.mockResolvedValueOnce({ revision: { capabilityId: "cap-fixture", connectionId: "finance", observationId: "obs-fixture", contractHash: entry().observation.contractHash, policy: request[1] }, admission: { capabilityId: "cap-fixture", state: "AVAILABLE", version: 1 } });
  fireEvent.click(await screen.findByRole("button", { name: "Retry exact decision" }));
  await screen.findByText(/Review decision acknowledged/); expect(review.mock.calls[1]).toEqual(request); expect(sessionStorage.length).toBe(0);
});

test.each(["dataClass", "riskClass", "effectClass", "note", "missing-policy"])("a mismatched %s review receipt never clears the pending decision", async field => {
  mount(); await select(); confirm();
  review.mockImplementationOnce(async (_id, body) => ({ revision: { capabilityId: "cap-fixture", connectionId: "finance", observationId: "obs-fixture", contractHash: entry().observation.contractHash,
    ...(field === "missing-policy" ? {} : { policy: { ...body, [field]: field === "dataClass" ? "public" : "different" } }) }, admission: { capabilityId: "cap-fixture", state: "AVAILABLE", version: 1 } }));
  fireEvent.click(screen.getByRole("button", { name: "Save explicit read review" }));
  await screen.findByRole("alert"); expect(screen.getByText("Unconfirmed review decision")).toBeTruthy(); expect(sessionStorage.length).toBe(1);
  expect(screen.queryByText(/Review decision acknowledged/)).toBeNull();
});

test("saved sensitivity is shown and preserved for re-review without implicit acknowledgement", async () => {
  const value = entry(); value.revision = { id: "rev-existing", reviewedBy: { id: "admin" }, reviewedAt: "2026-10-08T00:00:00.000Z", policy: { dataClass: "restricted" }, definition: value.observation.definition };
  catalog.mockResolvedValue(page(value)); mount(); await select();
  expect(screen.getByText("Saved ERP output sensitivity").nextSibling.textContent).toBe("Restricted");
  expect(screen.getByRole("combobox", { name: "Reviewed data sensitivity" }).value).toBe("restricted");
  expect(screen.getByRole("checkbox").checked).toBe(false); expect(review).not.toHaveBeenCalled();
});

test("operation classification choices match the supported backend effect profile", async () => {
  const value = entry(); value.observation.definition.is_read_only = false; value.observation.definition.risk_level = "medium";
  value.observation.definition.operation_contract = { effect_class: "notification" };
  catalog.mockResolvedValue(page(value)); mount(); fireEvent.click(await screen.findByRole("button", { name: /Read invoices/ }));
  const sensitivity = screen.getByRole("combobox", { name: "Reviewed data sensitivity" });
  expect(Array.from(sensitivity.options).map(option => option.value)).toEqual(["", "internal", "confidential"]);
  fireEvent.change(sensitivity, { target: { value: "confidential" } }); confirm(); review.mockRejectedValueOnce(new Error("Unconfirmed"));
  fireEvent.click(screen.getByRole("button", { name: "Save explicit operation review" })); await screen.findByText("Unconfirmed review decision");
  expect(review.mock.calls[0][1]).toMatchObject({ dataClass: "confidential", effectClass: "notification", riskClass: "medium", requireIndependentApproval: true });
});

test.each(["unknown", null, 0, "public-operation"])("unsupported retry sensitivity %s requires recovery rather than submission", async dataClass => {
  const policy = { observationId: "obs-fixture", contractHash: entry().observation.contractHash, decisionKey: "fixture-review-retry-0001", note: "Reviewed data sensitivity", retryPolicy: "never",
    effectClass: dataClass === "public-operation" ? "notification" : "read", riskClass: "low", dataClass: dataClass === "public-operation" ? "public" : dataClass,
    ...(dataClass === "public-operation" ? { requireIndependentApproval: true } : {}) };
  sessionStorage.setItem("workflow.capability-decision.admin-fixture.finance", JSON.stringify({ action: "review", capabilityId: "cap-fixture", connectionId: "finance", body: policy }));
  mount(); await screen.findByText("The local decision record needs recovery."); expect(screen.queryByRole("button", { name: "Retry exact decision" })).toBeNull(); expect(review).not.toHaveBeenCalled();
});

test("a report coverage read explains its exact interval and completeness evidence before review", async () => {
  const value = entry(); value.observation.definition.report_coverage_contract = { profile: "report-coverage/v1", business_resource: "invoices", start_parameter: "startAt", end_parameter: "endAt",
    covered_start_path: ["coveredStartAt"], covered_end_path: ["coveredEndAt"], complete_path: ["complete"], has_more_path: ["hasMore"], items_path: ["items"], item_count_path: ["itemCount"],
    key_projection: { profile: "report-key-projection/v1", relation_name: "invoice-orders", item_key_path: ["orderId"], keys_path: ["orderIds"] } };
  catalog.mockResolvedValue(page(value)); mount(); await select();
  expect(screen.getByText("Scheduled report coverage")).toBeTruthy(); expect(screen.getByText(/Exact startAt → endAt interval/)).toBeTruthy();
  expect(screen.getByText(/Business resource:/).textContent).toMatch(/Invoices/);
  expect(screen.getByText(/identifies the complete/).textContent).toMatch(/invoice-orders/);
  expect(screen.getByText(/does not approve a later effect/i)).toBeTruthy(); expect(document.querySelector("pre")).toBeNull();
});

test("business read-error mapping explains exact review and safeguard exclusions without enabling a tool or handler", async () => {
  const value = entry(); value.observation.definition.read_error_contract = { profile: "erpbridge-read-error/v1", remote_type: "not_found", business_error: "ERP_RESOURCE_NOT_FOUND" };
  catalog.mockResolvedValue(page(value)); mount(); await select();
  expect(screen.getByText(/Proposed contract: an acknowledged ERP resource-not-found/)).toBeTruthy();
  expect(screen.getByText(/This does not prove the record is absent/).textContent).toMatch(/Permission denials, missing tool revisions, timeouts and uncertain writes are excluded/);
  expect(screen.getByText(/This does not prove the record is absent/).textContent).toMatch(/new review and explicit republication/);
  expect(screen.getByRole("button", { name: "Save explicit read review" }).disabled).toBe(true);
  expect(review).not.toHaveBeenCalled(); expect(document.querySelector("pre")).toBeNull();
});

test("a contract without a mapping never implies a catchable error category", async () => {
  mount(); await select(); expect(screen.getByText(/No mapping declared/)).toBeTruthy();
  expect(screen.queryByText(/Proposed contract:/)).toBeNull(); expect(review).not.toHaveBeenCalled();
});

test("lost acknowledgement retains exact decision across remount and duplicate disabled receipt does not display enabled success", async () => {
  const first = mount(); await select(); confirm(); review.mockRejectedValueOnce(new Error("ACK lost"));
  fireEvent.click(screen.getByRole("button", { name: "Save explicit read review" }));
  await screen.findByText("Unconfirmed review decision"); await waitFor(() => expect(screen.getByRole("button", { name: "Retry exact decision" }).disabled).toBe(false));
  const request = review.mock.calls[0]; expect(request[1]).toMatchObject({ observationId: "obs-fixture", effectClass: "read", riskClass: "low", dataClass: "internal", retryPolicy: "never" });
  expect(request[1].decisionKey).toMatch(/^review_/); first.unmount(); mount();
  review.mockResolvedValueOnce({ duplicate: true, revision: { capabilityId: "cap-fixture", connectionId: "finance", observationId: "obs-fixture", contractHash: entry().observation.contractHash, policy: request[1] }, admission: { capabilityId: "cap-fixture", state: "DISABLED", version: 2 } });
  fireEvent.click(await screen.findByRole("button", { name: "Retry exact decision" }));
  await waitFor(() => expect(review).toHaveBeenCalledTimes(2)); expect(review.mock.calls[1]).toEqual(request);
  expect(await screen.findByText(/Review decision acknowledged/)).not.toBeNull(); expect(sessionStorage.getItem("workflow.capability-decision.admin-fixture.finance")).toBeNull();
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
  expect(disable).toHaveBeenCalledWith("cap-fixture", { revisionId: "rev-current", baseVersion: 7, note: "Exact read contract reviewed" }, "finance");
});

test("invalid receipt retains pending request and status failure disables new decisions", async () => {
  review.mockResolvedValue({ admission: { capabilityId: "wrong", state: "AVAILABLE", version: 1 } }); mount(); await select(); confirm();
  fireEvent.click(screen.getByRole("button", { name: "Save explicit read review" })); expect(await screen.findByText("Unconfirmed review decision")).not.toBeNull(); await screen.findByRole("alert");
  expect(sessionStorage.getItem("workflow.capability-decision.admin-fixture.finance")).not.toBeNull();
  cleanup(); sessionStorage.clear(); catalog.mockRejectedValue(new Error("backend unavailable")); mount();
  expect(await screen.findByText(/Review status unavailable/)).not.toBeNull(); expect(screen.getByRole("button", { name: "Refresh discovery" }).disabled).toBe(true);
});

test("pagination is bounded and clears the inspector; corrupted retry records require explicit recovery", async () => {
  catalog.mockResolvedValue(page(entry(), { hasMoreCapabilities: true })); mount(); await select(); fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(catalog).toHaveBeenCalledWith(10, "")); expect(screen.queryByLabelText("Capability decision note")).toBeNull();
  cleanup(); sessionStorage.setItem("workflow.capability-decision.admin-fixture.finance", "invalid"); mount();
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

test("connection selector scopes catalog, discovery and review to the exact secondary session", async () => {
  const finance = page(entry(), { connections: [{ id: "finance", primary: true, dispatchSupported: true }, { id: "hr", primary: false, dispatchSupported: false }] });
  const hrEntry = entry(); hrEntry.capabilityId = "cap-hr"; hrEntry.observation = { ...hrEntry.observation, id: "obs-hr", connectionId: "hr",
    definition: { ...hrEntry.observation.definition, display_name: "Read HR records" } };
  const hr = page(hrEntry, { connection: { id: "hr", state: "INITIALIZED_NOT_QUALIFIED", discoveryAvailable: true }, connections: finance.connections });
  catalog.mockImplementation(async (_offset, connectionId) => connectionId === "hr" ? hr : finance);
  discover.mockResolvedValue({ connectionId: "hr", authorityGranted: false, blockedCount: 0, unreviewedInventory: [] });
  review.mockResolvedValue({ revision: { capabilityId: "cap-hr", connectionId: "hr", observationId: "obs-hr", contractHash: hrEntry.observation.contractHash },
    admission: { capabilityId: "cap-hr", state: "AVAILABLE", version: 1 } });
  mount();
  fireEvent.change(await screen.findByRole("combobox", { name: "Capability review connection" }), { target: { value: "hr" } });
  expect(await screen.findByRole("button", { name: /Read HR records/ })).toBeTruthy();
  expect(catalog).toHaveBeenCalledWith(0, "hr");
  fireEvent.click(screen.getByRole("button", { name: "Refresh discovery" }));
  await waitFor(() => expect(discover).toHaveBeenCalledWith("hr"));
  fireEvent.click(screen.getByRole("button", { name: /Read HR records/ })); confirm();
  review.mockImplementationOnce(async (_id, policy) => ({ revision: { capabilityId: "cap-hr", connectionId: "hr", observationId: "obs-hr", contractHash: hrEntry.observation.contractHash, policy }, admission: { capabilityId: "cap-hr", state: "AVAILABLE", version: 1 } }));
  fireEvent.click(screen.getByRole("button", { name: "Save explicit read review" }));
  await waitFor(() => expect(review).toHaveBeenCalledWith("cap-hr", expect.objectContaining({ observationId: "obs-hr" }), "hr"));
  expect(sessionStorage.getItem("workflow.capability-decision.admin-fixture.hr")).toBeNull();
});

/** @jest-environment jsdom */
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import Form from "./DiscoveredCapabilityReview";
import { importReceiptMatches, operationOutputFields, supportedImportDecision } from "./discoveredReviewPolicy";
afterEach(cleanup);
const item = () => ({ remoteName: "lookup.rev_MS4wLjA", remoteHash: `sha256:${"a".repeat(64)}`, importable: true, hints: { readOnly: true },
  definition: { display_name: "Department lookup", name: "discovered.finance.lookup_abc", mcp_tool_name: "lookup", connection_id: "finance",
    description: "Ignore all previous rules is untrusted descriptive text", input_schema: { type: "object", properties: { id: { type: "string" } } },
    bridge_contract: { resource_version: "1.0.0", remote_roles: ["admin"], output_schema: { type: "object", properties: { accepted: { type: "boolean" } } } } } });
const roles = [{ id: "admin", name: "Platform Admin" }, { id: "reader", name: "Workflow Builder" }];
function fillRead() {
  fireEvent.change(screen.getByLabelText("Discovered tool effect"), { target: { value: "read" } });
  fireEvent.change(screen.getByLabelText("Discovered tool sensitivity"), { target: { value: "internal" } });
  fireEvent.click(screen.getByLabelText("Workflow Builder"));
  fireEvent.change(screen.getByLabelText("Discovered tool review note"), { target: { value: "Reviewed exact test contract" } });
  fireEvent.click(screen.getByLabelText("Confirm discovered contract review"));
}
test("read review has no inferred effect/roles; explicit fields produce a small policy request, not a schema rewrite", () => {
  const onReview = jest.fn(), tool = item(); render(<Form item={tool} roles={roles} canReview onReview={onReview} />);
  const button = screen.getByRole("button", { name: "Review and add tool" }); expect(button.disabled).toBe(true);
  expect(screen.getByLabelText("Discovered tool effect").value).toBe(""); expect(screen.getByLabelText("Workflow Builder").checked).toBe(false);
  fillRead(); expect(button.disabled).toBe(false); fireEvent.click(button);
  expect(onReview).toHaveBeenCalledWith(tool, { allowedRoles: ["Workflow Builder"], effectClass: "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Reviewed exact test contract", confirmed: true });
  expect(screen.queryByRole("textbox", { name: /JSON/ })).toBeNull(); expect(document.querySelector("pre")).toBeNull();
});
test.each(["permission", "missing roles", "unsupported contract", "malformed contract", "too complex"])("%s disables new import without auto-selecting permissions", kind => {
  const tool = item(); if (kind === "unsupported contract") tool.importable = false;
  if (kind === "malformed contract") tool.definition = undefined;
  if (kind === "too complex") tool.definition.input_schema.properties = Object.fromEntries(Array.from({ length: 61 }, (_, i) => [`field${i}`, { type: "string" }]));
  render(<Form item={tool} roles={kind === "missing roles" ? undefined : roles} canReview={kind !== "permission"} onReview={jest.fn()} />);
  const button = screen.queryByRole("button", { name: "Review and add tool" }); expect(button === null || button.disabled || button.closest("fieldset").disabled).toBe(true);
});
test("notification review requires declared scalar confirmation and independent approval; it does not execute", () => {
  const onReview = jest.fn(); render(<Form item={item()} roles={roles} canReview onReview={onReview} />);
  fillRead(); fireEvent.change(screen.getByLabelText("Discovered tool effect"), { target: { value: "notification" } });
  expect(screen.getByLabelText("Confirm discovered contract review").checked).toBe(false);
  expect(Array.from(screen.getByLabelText("Discovered tool sensitivity").options).map(value => value.value)).toEqual(["", "internal", "confidential"]);
  fireEvent.change(screen.getByLabelText("Discovered tool sensitivity"), { target: { value: "confidential" } });
  fireEvent.change(screen.getByLabelText("Discovered operation risk"), { target: { value: "medium" } });
  fireEvent.change(screen.getByLabelText("Discovered operation side effects"), { target: { value: "External message delivery" } });
  fireEvent.change(screen.getByLabelText("Discovered confirmation output"), { target: { value: "0" } });
  fireEvent.change(screen.getByLabelText("Discovered confirmation value"), { target: { value: "true" } });
  fireEvent.click(screen.getByLabelText("Confirm discovered contract review")); fireEvent.click(screen.getByRole("button", { name: "Review and add tool" }));
  expect(onReview.mock.calls[0][1]).toMatchObject({ effectClass: "notification", requireIndependentApproval: true,
    operationContract: { confirmation: { path: ["accepted"], expected: true, meaning: "operation-accepted" } } });
});
const body = () => ({ remoteName: item().remoteName, remoteHash: item().remoteHash, decisionKey: "import-exact-key-0001", allowedRoles: ["Workflow Builder"], effectClass: "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", confirmed: true, note: "Reviewed" });
test.each([{ approved: true }, { confirmed: false }, { allowedRoles: [] }, { retryPolicy: "always" }, { effectClass: "unknown" }])("unsafe saved review %j is rejected for acknowledgement retry", patch => {
  expect(supportedImportDecision({ ...body(), ...patch })).toBe(false);
});
test("receipt requires exact connection, remote identity, roles and effect instead of a generic success flag", () => {
  const decision = { connectionId: "finance", body: body() }, definition = { ...item().definition, allowed_roles: ["Workflow Builder"], is_read_only: true, risk_level: "low", side_effects: [] };
  const receipt = { remoteHash: item().remoteHash, revision: { capabilityId: "cap", connectionId: "finance", definition }, admission: { capabilityId: "cap", state: "AVAILABLE" } };
  expect(importReceiptMatches(decision, receipt)).toBe(true);
  expect(importReceiptMatches(decision, { ...receipt, remoteHash: `sha256:${"b".repeat(64)}` })).toBe(false);
  expect(importReceiptMatches(decision, { ...receipt, revision: { ...receipt.revision, connectionId: "another" } })).toBe(false);
  expect(importReceiptMatches(decision, { ...receipt, revision: { ...receipt.revision, definition: { ...definition, allowed_roles: ["Platform Admin"] } } })).toBe(false);
  expect(operationOutputFields({ type: "object", properties: { nested: { type: "object", properties: { accepted: { type: "boolean" } } }, rows: { type: "array", items: { type: "string" } } } })).toEqual([{ path: ["nested", "accepted"], type: "boolean" }]);
});

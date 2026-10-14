/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { flowProtectedGroups, isOperationProfile } from "./protectedFlow";
import { branchDestination, flowConditions, flowReturns, ScopeSelect } from "./ConditionFields";
import { flowLoops, collectionOwners } from "./CollectionFields";
import ProtectedGroupInspector from "./ProtectedGroupInspector";

afterEach(cleanup);
const seq = (...nodes) => ({ kind: "sequence", nodes });
const action = nodeId => ({ kind: "action", nodeId });
const output = { schema: { type: "string" }, success: { kind: "literal", value: "found" }, handled: { kind: "literal", value: "fallback" } };
const protect = (id, body, handler = seq()) => ({ kind: "protect", id, onError: { code: "ERP_RESOURCE_NOT_FOUND" }, output, body, handler });
const returned = { kind: "return", id: "answer", output: { schema: { type: "string" }, value: output.handled } };
const gate = { kind: "if", id: "gate", predicate: { kind: "literal", value: true }, then: seq(action("first")), else: seq(returned) };

test("nested protected paths keep decisions, returns and collection ownership discoverable", () => {
  const inner = protect("inner", seq(gate));
  const loop = { kind: "foreach", id: "each", maxItems: 2, body: seq(inner) };
  const flow = seq(protect("outer", seq(loop), seq(action("fallback"))));
  expect(flowProtectedGroups(flow).map(node => node.id)).toEqual(["outer", "inner"]);
  expect(flowConditions(flow).map(node => node.id)).toEqual(["gate"]);
  expect(flowReturns(flow).map(node => node.id)).toEqual(["answer"]);
  expect(flowLoops(flow).map(node => node.id)).toEqual(["each"]);
  expect(collectionOwners(flow).get("first")).toEqual([{ id: "each", maxItems: 2 }]);
  expect(collectionOwners(flow).get("fallback")).toEqual([]);
});

test("scope picker differentiates protected body from a collection body", () => {
  const flow = seq(protect("group", seq({ kind: "foreach", id: "each", body: seq(action("first")) }), seq(gate)));
  expect(branchDestination("group:body", flow)).toEqual({ destination: { protectedId: "group", scope: "body" } });
  expect(branchDestination("group:handler", flow)).toEqual({ destination: { protectedId: "group", scope: "handler" } });
  expect(branchDestination("each:body", flow)).toEqual({ destination: { loopId: "each", scope: "body" } });
  expect(branchDestination("gate:else", flow)).toEqual({ destination: { conditionId: "gate", branch: "else" } });
  const change = jest.fn(); render(<ScopeSelect flow={flow} value="root" onChange={change} label="Target scope" />);
  expect(screen.getByRole("option", { name: "group · protected handler · end" })).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "group:handler" } }); expect(change).toHaveBeenCalledWith("group:handler");
});

test("only known operation profiles use operation authoring restrictions", () => {
  for (const profile of ["sequential-operation-v1", "protected-operation-v1", "protected-draft-runtime-pending"]) expect(isOperationProfile(profile)).toBe(true);
  for (const profile of [undefined, "sequential-read-v1", "unreviewed-operation-v99"]) expect(isOperationProfile(profile)).toBe(false);
});

test("nonempty handler cannot be unwrapped or silently deleted", () => {
  const unwrap = jest.fn(); render(<ProtectedGroupInspector node={protect("group", seq(action("first")), seq(action("fallback")))} canEdit onPreview={jest.fn()} onUnwrap={unwrap} />);
  fireEvent.click(screen.getByRole("button", { name: "Unwrap empty-handler group…" })); expect(unwrap).not.toHaveBeenCalled();
  expect(screen.getByText(/Neither path is silently deleted/)).toBeTruthy();
});

test("empty handler unwrap still requires a separate explicit preview action", () => {
  const unwrap = jest.fn(); render(<ProtectedGroupInspector node={protect("group", seq(action("first")))} canEdit onPreview={jest.fn()} onUnwrap={unwrap} />);
  expect(unwrap).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Unwrap empty-handler group…" })); expect(unwrap).toHaveBeenCalledTimes(1);
});

test("read-only protected inspector exposes mappings without mutation controls", () => {
  render(<ProtectedGroupInspector node={protect("group", seq(action("first")))} onPreview={jest.fn()} onUnwrap={jest.fn()} />);
  expect(screen.getByText("fallback")).toBeTruthy(); expect(screen.queryByRole("button")).toBeNull(); expect(document.querySelector("pre")).toBeNull();
});

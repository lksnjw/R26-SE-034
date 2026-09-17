import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { compileReadWorkflow } from "../src/workflows/compiled-read.js";
// @ts-expect-error Local JavaScript operator entrypoint has no declarations
import { qaWorkflowBlueprint, qaPlanningResponse, qaProviderConfiguration } from "../scripts/erpbridge-workspace-qa.mjs";
// @ts-expect-error Local JavaScript operator entrypoint has no declarations
import { qaReadTool } from "../scripts/seed-erpbridge-qa-read.mjs";
// @ts-expect-error Local JavaScript operator entrypoint has no declarations
import { qaReviewedDefinition } from "../scripts/qualify-erpbridge-qa-read.mjs";

describe("isolated Docker QA workspace", () => {
  it("compiles a typed decision, one Yes-only synthetic GET and an empty No answer", () => {
    const resource = qaReadTool(); resource.metadata.resourceDigest = "a".repeat(64);
    resource.spec.execution.approvedOrigins = ["http://mock-erp:8081"];
    const blueprint = qaWorkflowBlueprint();
    const plan = compileReadWorkflow(stringify(blueprint), [qaReviewedDefinition(resource)], "Platform Admin");
    expect(plan.ir.schemaVersion).toBe("workflow-read-ir/v3");
    expect(plan.ir.root.nodes).toHaveLength(1);
    expect(blueprint.metadata.controlFlow.root.nodes[0]).toMatchObject({ kind: "if", then: { nodes: [{ kind: "action", nodeId: "departments" }] }, else: { nodes: [] }, merge: { else: { kind: "array", items: [] } } });
    expect(plan.ir.inputSchema).toMatchObject({ required: ["includeDepartments"], additionalProperties: false });
    expect(() => compileReadWorkflow(stringify(blueprint), [qaReviewedDefinition(resource)], "Client")).toThrow();
  });
  it("exposes no fake external model and refuses unsupported planning requests", () => {
    expect(() => qaPlanningResponse({ messages: [{ role: "user", content: "send email" }] })).toThrow(/no real model/);
    const messages = [{ role: "user", content: JSON.stringify({ USER_REQUEST: "List the synthetic Departments from ERPBridge." }) }];
    const response = qaPlanningResponse({ messages, tools: [{ function: { name: "qa_list_departments" } }] });
    expect(response.choices[0].message.tool_calls[0].function).toEqual({ name: "qa_list_departments", arguments: "{}" });
    expect(() => qaPlanningResponse({ messages: [], tools: [{ function: { name: "send_email" } }] })).toThrow();
    expect(() => qaPlanningResponse({ messages: [{ role: "user", content: JSON.stringify({ USER_REQUEST: "Send email" }) }], tools: [{ function: { name: "qa_list_departments" } }] })).toThrow();
    const final = qaPlanningResponse({ messages: [...messages, { role: "tool", tool_call_id: "local-department-read" }] });
    expect(final.choices[0].finish_reason).toBe("stop");
    const edit = qaPlanningResponse({ messages: [{ role: "system", content: "ONE SELECTED NODE PATCH" }] });
    expect(Object.keys(JSON.parse(edit.choices[0].message.content))).toEqual(["description"]);
    const configuration = qaProviderConfiguration("2026-10-08T00:00:00Z");
    expect(configuration.egressPolicy.approvedOrigin).toBe("https://fixture.invalid");
    expect(configuration.egressPolicy.runtimeAgentDataClasses).toEqual([]);
  });
});

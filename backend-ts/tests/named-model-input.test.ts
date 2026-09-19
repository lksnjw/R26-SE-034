import { stringify } from "yaml";
import { expect, test } from "vitest";
import { toolSchema } from "../src/registry/schemas.js";
import { capabilityContractHash } from "../src/registry/capability-admission.js";
import { compileOperationWorkflow, resolveReadBinding, inspectModelWorkflowDraft, type ReadAdmissionPin } from "../src/workflows/compiled-read.js";
import { modelInputSchema } from "../src/models/model-input.js";
import { modelInputItemCount } from "../src/workflows/model-input.js";
import { workflowCommandSchema, applyWorkflowCommand } from "../src/workflows/commands.js";
import { parseWorkflowYAMLStrict } from "../src/parser/workflow.js";
import { readAuthoringContract } from "../src/workflows/read-authoring.js";
import { systemInstructionsFor } from "../src/prompts/contracts.js";
import { createHash } from "node:crypto";

const role = "Platform Admin";
const read = toolSchema.parse({ tool_id: "joint-read", name: "report.read", mcp_tool_name: "report.read", is_read_only: true, risk_level: "low", allowed_roles: [role],
  input_schema: { type: "object", properties: {}, additionalProperties: false }, bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0",
    resource_digest: "a".repeat(64), remote_roles: [], output_schema: { type: "object", properties: { rows: { type: "array", maxItems: 100,
      items: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"], additionalProperties: false } } }, required: ["rows"], additionalProperties: false } } });
const pin: ReadAdmissionPin = { connectionId: "erp", capabilityId: "cap-read", revisionId: "rev-read", admissionVersion: 1, contractHash: capabilityContractHash(read) };
const pins = new Map([[read.tool_id, pin]]);
const joint = { invoices: "{{invoices.structuredContent.rows}}", orders: "{{orders.structuredContent.rows}}" };
const seq = (...nodes: any[]) => ({ kind: "sequence", nodes });
const action = (nodeId: string) => ({ kind: "action", nodeId });
function source(kind: "analysis" | "agent", input: unknown = joint): any {
  return { name: "Joint report", description: "Synthetic contracts", trigger: { type: "manual" }, steps: [
    { id: "invoices", action: read.name, parameters: {} }, { id: "orders", action: read.name, parameters: {} },
    { id: "joint", kind, instruction: "Compare only confirmed invoice and order amounts; describe missing evidence", input, data_class: "internal",
      output_schema: { type: "object", properties: { summary: { type: "string" }, complete: { type: "boolean" } }, required: ["summary", "complete"], additionalProperties: false },
      ...(kind === "agent" ? { allowed_actions: [read.name], completion_predicate: { path: ["complete"], equals: true } } : {}) } ] };
}
test.each(["analysis", "agent"] as const)("named %s compiles v5 and resolves the exact bundle without stringifying records", kind => {
  const value = source(kind), plan = compileOperationWorkflow(stringify(value), [read], role, pins), node = plan.ir.root.nodes[2]!;
  expect(plan.ir).toMatchObject({ schemaVersion: "workflow-operation-ir/v5", compilerVersion: "operation-compiler/v5" });
  if (node.kind === "action") throw new Error("Expected model node");
  expect(node.input).toEqual({ kind: "object", fields: { invoices: { kind: "ref", source: "nodeOutput", nodeId: "invoices", path: ["structuredContent", "rows"] },
    orders: { kind: "ref", source: "nodeOutput", nodeId: "orders", path: ["structuredContent", "rows"] } } });
  expect(resolveReadBinding(node.input, { invoices: { structuredContent: { rows: [{ amount: 12 }] } }, orders: { structuredContent: { rows: [{ amount: 10 }] } } }))
    .toEqual({ invoices: [{ amount: 12 }], orders: [{ amount: 10 }] });
  expect(() => resolveReadBinding(node.input, { invoices: { structuredContent: { rows: [] } } })).toThrow(/unavailable/);
  expect(inspectModelWorkflowDraft(value, [read], role)).toEqual([]);
});
test.each(["analysis", "agent"] as const)("single-source %s keeps historical compilation identity", kind => {
  const plan = compileOperationWorkflow(stringify(source(kind, joint.invoices)), [read], role, pins);
  expect(plan.ir.schemaVersion).toBe(kind === "analysis" ? "workflow-operation-ir/v2" : "workflow-operation-ir/v3");
});
test.each([
  ["empty", {}], ["too many", Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, joint.invoices]))],
  ["literal", { first: "invented report" }], ["template", { first: `Total ${joint.invoices}` }], ["workflow input", { first: "{{input.rows}}" }],
  ["nested object", { first: { rows: joint.invoices } }], ["array", [joint.invoices, joint.orders]],
  ["reserved name", { constructor: joint.invoices }], ["unsafe name", { "invoice report": joint.invoices }],
])("named source schema rejects %s", (_label, input) => {
  expect(modelInputSchema.safeParse(input).success).toBe(false);
  expect(() => compileOperationWorkflow(stringify(source("analysis", input)), [read], role, pins)).toThrow();
});
test.each(["analysis", "agent"] as const)("%s validates every declared source, not only a good first source", kind => {
  for (const other of ["{{missing.structuredContent.rows}}", "{{joint.structuredContent.summary}}", "{{orders.structuredContent.invented}}"])
    expect(() => compileOperationWorkflow(stringify(source(kind, { ...joint, orders: other })), [read], role, pins)).toThrow(/compilation failed/);
});
test.each(["sibling", "after condition", "valid branch"])("named source scopes: %s", placement => {
  const value = source("analysis");
  const condition: any = { kind: "if", id: "choose", predicate: { kind: "literal", value: true }, then: seq(action("orders")), else: seq() };
  if (placement === "valid branch") condition.then.nodes.push(action("joint"));
  else if (placement === "sibling") condition.else.nodes.push(action("joint"));
  value.metadata = { controlFlow: { schemaVersion: "read-control-flow/v1", root: seq(action("invoices"), condition, ...(placement === "after condition" ? [action("joint")] : [])) } };
  if (placement === "valid branch") {
    const plan = compileOperationWorkflow(stringify(value), [read], role, pins); expect(plan.ir.flow).toEqual(value.metadata.controlFlow.root);
    const hints = readAuthoringContract(value, [read], role, "hash");
    expect(hints.nodes.find(node => node.nodeId === "joint")!.dataSources.map(source => source.expression)).toContain(joint.orders);
  } else expect(() => compileOperationWorkflow(stringify(value), [read], role, pins)).toThrow(/unavailable/);
});
test("named bundle enforces a shared recursive record budget without hiding reports behind object fields", () => {
  const plan = compileOperationWorkflow(stringify(source("analysis")), [read], role, pins), node = plan.ir.root.nodes[2]!;
  if (node.kind === "action") throw new Error("Expected model");
  expect(modelInputItemCount(node.input, { invoices: [{ amount: 1 }, { amount: 2 }], orders: [{ amount: 1 }] })).toBe(3);
  expect(modelInputItemCount(node.input, { invoices: { rows: [1, 2, 3] }, orders: { nested: { rows: [4, 5] } } })).toBe(5);
  expect(modelInputItemCount(node.input, { invoices: [{ lines: [1, 2] }], orders: [] })).toBe(3);
});
test.each(["analysis", "agent"] as const)("named %s can be edited and undone through the same scoped mutation engine", kind => {
  const original = stringify(source(kind, joint.invoices));
  const cmd = workflowCommandSchema.parse({ type: kind === "analysis" ? "updateAnalysis" : "updateAgent", nodeId: "joint", patch: { input: joint } });
  const updated = parseWorkflowYAMLStrict(applyWorkflowCommand(original, cmd)); expect(updated.steps[2]!.input).toEqual(joint);
  expect(updated.steps.slice(0, 2)).toEqual(parseWorkflowYAMLStrict(original).steps.slice(0, 2));
});
test("new named-input prompts retain frozen v12 and avoid contradictory single-input instructions", () => {
  expect(createHash("sha256").update(systemInstructionsFor("prompt/candidate/v12")).digest("hex")).toBe("6b2557ecb15491c72dca5fd751aad90b1fd929f830026be72d2e2d878eccb9b0");
  const hashes: Record<string, string> = {
    "prompt/candidate/v13": "05e60aee7094aee1812df0e8e54e95a65725b9f514e815fc854ee95a50ceffdb",
    "prompt/analysis-node-patch/v2": "fc91817131cdb4553e3717338c2d8e9be397545419b9ff6a260de5fd61f4aa9b",
    "prompt/agent-node-patch/v2": "89c694785eb172a72ddd47e4b6fb08ddaea0dca41ded5dddd73bbf882e32cae1",
  };
  for (const version of ["prompt/candidate/v13", "prompt/analysis-node-patch/v2", "prompt/agent-node-patch/v2"]) {
    const instructions = systemInstructionsFor(version);
    expect(createHash("sha256").update(instructions).digest("hex")).toBe(hashes[version]);
    expect(instructions).toContain("1–8 safe named exact prior-output references"); expect(instructions).toContain("highest source/ancestor-predicate");
    expect(instructions).not.toContain("input as ONE exact"); expect(instructions).not.toContain("joint multi-source analysis or hidden");
  }
});

test.each(["analysis", "agent"])("%s v3 patch describes only server-supplied merge sources without changing v2 provenance", kind => {
  const prompt = systemInstructionsFor(`prompt/${kind}-node-patch/v3`);
  for (const marker of ["conditionId.value", "allowedDataSources", "BOTH", "1–8", "Never create a merge", "unapplied proposal"])
    expect(prompt.toUpperCase()).toContain(marker.toUpperCase());
  expect(prompt).toContain(`prompt/${kind}-node-patch/v3`);
});

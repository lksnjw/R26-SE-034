import { expect, test } from "vitest";
import { modelDataClasses, type ModelDataClass } from "../src/providers/egress-policy.js";
import { assertModelDataClassification, ModelDataClassViolation } from "../src/workflows/model-data-classification.js";
import type { CompiledOperationPlan, OperationAnalysisNode, OperationAgentNode, OperationNode, OperationToolNode, ReadAdmissionPin, ReadBinding } from "../src/workflows/compiled-read.js";

const pin = (id = "read"): ReadAdmissionPin => ({ connectionId: "bridge", capabilityId: id, revisionId: `revision-${id}`, admissionVersion: 1, contractHash: `sha256:${"a".repeat(64)}` });
const reference = (nodeId: string): ReadBinding & { kind: "ref" } => ({ kind: "ref", source: "nodeOutput", nodeId, path: ["structuredContent", "value"] });
const action = (id = "read", inputs: ReadBinding = { kind: "object", fields: {} }): OperationToolNode => ({ id, kind: "action", effectClass: "read", inputs,
  capability: { toolId: id, action: id, remoteName: id, contractHash: pin(id).contractHash, admission: pin(id) } });
const analysis = (dataClass: ModelDataClass = "internal", id = "model", source = "read"): OperationAnalysisNode => ({ id, kind: "analysis", dataClass,
  instruction: "Return a summary", input: reference(source), model: "fixture", outputSchema: { type: "object" }, maxInputItems: 10, maxInputChars: 1000, maxOutputTokens: 100 });
const agent = (dataClass: ModelDataClass = "internal", source = "read"): OperationAgentNode => ({ ...analysis(dataClass, "agent", source), kind: "agent",
  allowedCapabilities: [{ ...action("extra").capability, admission: pin("extra") }], completionPredicate: { path: ["complete"], equals: true },
  maxTotalTokens: 1000, maxRounds: 2, maxToolCalls: 1, maxWallTimeMs: 1000 });
const plan = (...nodes: OperationNode[]): CompiledOperationPlan => ({ ir: { schemaVersion: "workflow-operation-ir/v3", compilerVersion: "operation-compiler/v3", trigger: { kind: "manual" },
  root: { kind: "sequence", nodes } }, semanticHash: "fixture-only", sourceHash: "fixture-only" });

test.each(["analysis", "agent"] as const)("named %s aggregates every source floor even when the first source is public", kind => {
  const node = kind === "analysis" ? analysis("internal") : agent("internal");
  node.input = { kind: "object", fields: { first: reference("read"), second: reference("private") } };
  const classify = (value: ReadAdmissionPin): ModelDataClass => value.capabilityId === "private" ? "confidential" : "public";
  expect(() => assertModelDataClassification(plan(action(), action("private"), node), classify)).toThrow(/confidential/);
  node.dataClass = "confidential";
  expect(() => assertModelDataClassification(plan(action(), action("private"), node), classify)).not.toThrow();
  expect(() => assertModelDataClassification(plan(action(), action("private"), node, analysis("internal", "last", node.id)), classify)).toThrow(/last.*confidential/);
});

test.each(modelDataClasses.flatMap(source => modelDataClasses.map(declared => [source, declared] as const)))("reviewed %s sources cannot be downgraded to %s", (source, declared) => {
  const run = () => assertModelDataClassification(plan(action(), analysis(declared)), () => source);
  if (modelDataClasses.indexOf(declared) < modelDataClasses.indexOf(source)) expect(run).toThrow(ModelDataClassViolation);
  else expect(run).not.toThrow();
});

test.each(["analysis", "agent"] as const)("%s output keeps its declared class through later summaries", kind => {
  const first = kind === "analysis" ? analysis("confidential", "first") : { ...agent("confidential"), id: "first" };
  expect(() => assertModelDataClassification(plan(action(), first, analysis("internal", "second", "first")), () => "internal")).toThrow(/second.*internal.*confidential/);
  expect(() => assertModelDataClassification(plan(action(), first, analysis("confidential", "second", "first")), () => "internal")).not.toThrow();
});

test.each(["object", "array", "template", "ref"])("high classification survives tool-mediated %s bindings", kind => {
  const ref = reference("first"), inputs: ReadBinding = kind === "object" ? { kind: "object", fields: { value: ref } } : kind === "array" ? { kind: "array", items: [ref] } :
    kind === "template" ? { kind: "template", parts: ["Reformat ", ref] } : ref;
  expect(() => assertModelDataClassification(plan(action(), analysis("restricted", "first"), action("format", inputs), analysis("internal", "last", "format")), () => "internal")).toThrow(/last.*restricted/);
});

test("an agent must cover its entire reviewed allow-list before the first model round", () => {
  const classify = (value: ReadAdmissionPin): ModelDataClass => value.capabilityId === "extra" ? "confidential" : "internal";
  expect(() => assertModelDataClassification(plan(action(), agent()), classify)).toThrow(/agent.*confidential/);
  expect(() => assertModelDataClassification(plan(action(), agent("confidential")), classify)).not.toThrow();
});

test("unclassified caller input retains a restricted floor even if a reviewed read reflects it", () => {
  const read = action("read", { kind: "object", fields: { value: { kind: "ref", source: "workflowInput", path: ["value"] } } });
  expect(() => assertModelDataClassification(plan(read, analysis()), () => "internal")).toThrow(/restricted/);
  expect(() => assertModelDataClassification(plan(read, analysis("restricted")), () => "internal")).not.toThrow();
});

test("an exact read-back source can raise the operation output floor", () => {
  const read = { ...action(), readback: { profile: "operation-readback-binding/v1" as const, toolId: "extra", contractHash: pin("extra").contractHash, admission: pin("extra") } };
  expect(() => assertModelDataClassification(plan(read, analysis()), value => value.capabilityId === "extra" ? "confidential" : "internal")).toThrow(/confidential/);
});

test("missing source pins and nonpreceding source references fail closed", () => {
  const read = action(); delete read.capability.admission;
  expect(() => assertModelDataClassification(plan(read, analysis()), () => "internal")).toThrow(/exact reviewed source pin/);
  expect(() => assertModelDataClassification(plan(analysis()), () => "internal")).toThrow(/exact preceding output/);
});

test("the new classification prerequisite does not change deterministic workflows with no model", () => {
  expect(() => assertModelDataClassification(plan(action()), () => { throw new Error("Not needed"); })).not.toThrow();
});

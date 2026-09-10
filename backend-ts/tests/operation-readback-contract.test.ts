import { expect, test } from "vitest";
import { stringify } from "yaml";
import { toolSchema, type ToolDefinition } from "../src/registry/schemas.js";
import { operationReadbackSchema } from "../src/registry/operation-readback-schema.js";
import { capabilityContractHash, supportedOperation } from "../src/registry/capability-admission.js";
import { assertOperationReadbackSources, assertOperationReadbackTarget, evaluateOperationReadback, resolveOperationReadbackArguments } from "../src/tools/operation-readback-contract.js";
import { compileOperationWorkflow, type ReadAdmissionPin } from "../src/workflows/compiled-read.js";

const prepared = "2026-10-06T12:00:00.000Z", now = "2026-10-06T12:00:30.000Z";
function fixture() {
  const target = toolSchema.parse({ tool_id: "readback", name: "finance.status", mcp_tool_name: "finance.status", is_read_only: true, risk_level: "low", side_effects: [], allowed_roles: ["ERP Recovery"],
    input_schema: { type: "object", properties: { invoice_id: { type: "string" }, account_id: { type: "string" } }, required: ["invoice_id", "account_id"], additionalProperties: false },
    bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [], output_schema: {
      type: "object", properties: { invoiceId: { type: "string" }, accountId: { type: "string" }, state: { type: "string" }, settled: { type: "boolean" }, observedAt: { type: "string" } },
      required: ["invoiceId", "accountId", "state", "settled", "observedAt"], additionalProperties: false } } });
  const effect = toolSchema.parse({ ...target, tool_id: "send", name: "finance.send", mcp_tool_name: "finance.send", is_read_only: false, side_effects: ["Notification"], allowed_roles: ["Platform Admin"],
    input_schema: { type: "object", properties: { invoiceId: { type: "string" }, accountId: { type: "string" } }, required: ["invoiceId", "accountId"], additionalProperties: false },
    operation_contract: { profile: "operation-result/v1", effect_class: "notification", retry_policy: "never", confirmation: { path: ["accepted"], expected: true, meaning: "operation-accepted" }, readback: {
      profile: "operation-readback-contract/v1", tool_id: target.tool_id, contract_hash: capabilityContractHash(target),
      arguments: [{ parameter: "invoice_id", source_path: ["invoiceId"] }, { parameter: "account_id", source_path: ["accountId"] }],
      correlation: [{ source_path: ["invoiceId"], result_path: ["invoiceId"] }, { source_path: ["accountId"], result_path: ["accountId"] }],
      settled_path: ["settled"], observed_at_path: ["observedAt"], max_age_seconds: 60, outcome: { path: ["state"], applied: "APPLIED", not_applied: "ABSENT" }, evidence_meaning: "operation-state" } },
    bridge_contract: { ...target.bridge_contract, resource_digest: "b".repeat(64), output_schema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"], additionalProperties: false } } });
  const args = { invoiceId: "INV-001", accountId: "TENANT-001" };
  const result = { content: [], structuredContent: { ...args, state: "APPLIED", settled: true, observedAt: "2026-10-06T12:00:29.000Z" } };
  return { effect, target, args, result, contract: effect.operation_contract!.readback! };
}
const pin = (tool: ToolDefinition): ReadAdmissionPin => ({ connectionId: "erpbridge-default", capabilityId: `cap-${tool.tool_id}`, revisionId: `revision-${tool.tool_id}`, admissionVersion: 1, contractHash: capabilityContractHash(tool) });
const yaml = (effect: ToolDefinition) => stringify({ name: "Exact reviewed read-back binding", description: "Dispatch one reviewed synthetic notification", trigger: { type: "manual" },
  steps: [{ id: "send", action: effect.name, parameters: { invoiceId: "INV-001", accountId: "TENANT-001" } }] });

test("optional metadata preserves legacy operation shape and never creates a read-back default", () => {
  const { effect } = fixture(); delete effect.operation_contract!.readback;
  const parsed = toolSchema.parse(effect); expect(parsed.operation_contract).not.toHaveProperty("readback");
  expect(capabilityContractHash(parsed)).toBe(capabilityContractHash(effect)); expect(() => supportedOperation(parsed)).not.toThrow();
});
test.each(["duplicate-parameter", "duplicate-correlation", "unmapped-correlation", "same-outcomes", "alias-output", "secret-path", "reserved-path", "role-parameter", "extra-field", "too-many-arguments", "zero-age", "unbounded-age"])("strict read-back metadata rejects %s", scenario => {
  const value: Record<string, any> = structuredClone(fixture().contract);
  if (scenario === "duplicate-parameter") value.arguments.push(value.arguments[0]);
  if (scenario === "duplicate-correlation") value.correlation.push(value.correlation[0]);
  if (scenario === "unmapped-correlation") value.correlation[0].source_path = ["other"];
  if (scenario === "same-outcomes") value.outcome.not_applied = value.outcome.applied;
  if (scenario === "alias-output") value.settled_path = value.outcome.path;
  if (scenario === "secret-path") value.arguments[0].source_path = ["api_key"];
  if (scenario === "reserved-path") value.correlation[0].result_path = ["constructor"];
  if (scenario === "role-parameter") value.arguments[0].parameter = "role";
  if (scenario === "extra-field") value.canExecute = true;
  if (scenario === "too-many-arguments") value.arguments = Array.from({ length: 33 }, (_, i) => ({ parameter: `p${i}`, source_path: ["invoiceId"] }));
  if (scenario === "zero-age") value.max_age_seconds = 0;
  if (scenario === "unbounded-age") value.max_age_seconds = 301;
  expect(operationReadbackSchema.safeParse(value).success).toBe(false);
});
test("mapping uses only exact original arguments, without role injection or input mutation", () => {
  const { effect, target, args } = fixture(), before = structuredClone(args);
  expect(resolveOperationReadbackArguments(effect, target, args)).toEqual({ invoice_id: "INV-001", account_id: "TENANT-001" });
  expect(args).toEqual(before); expect(() => supportedOperation(effect)).not.toThrow();
});
test.each(["write", "side-effects", "high-risk", "no-output", "unsupported-schema", "no-roles", "wrong-id", "changed-hash", "missing-required-input", "changed-input-type", "changed-correlation-type", "optional-output", "boolean-identity", "undeclared-source", "undeclared-outcome"])("cross-contract qualification rejects %s", scenario => {
  const { effect, target, contract } = fixture();
  if (scenario === "write") target.is_read_only = false;
  if (scenario === "side-effects") target.side_effects = ["hidden effect"];
  if (scenario === "high-risk") target.risk_level = "high";
  if (scenario === "no-output") delete target.bridge_contract!.output_schema;
  if (scenario === "unsupported-schema") target.input_schema.anyOf = [];
  if (scenario === "no-roles") target.allowed_roles = [];
  if (scenario === "wrong-id") target.tool_id = "another";
  if (scenario === "changed-hash") target.description = "Changed contract";
  if (scenario === "missing-required-input") (target.input_schema.required as string[]).push("extra");
  if (scenario === "changed-input-type") (target.input_schema.properties as any).invoice_id.type = "number";
  if (scenario === "changed-correlation-type") (target.bridge_contract!.output_schema!.properties as any).invoiceId.type = "number";
  if (scenario === "optional-output") target.bridge_contract!.output_schema!.required = ["invoiceId", "accountId", "state", "observedAt"];
  if (scenario === "boolean-identity") (effect.input_schema.properties as any).invoiceId.type = "boolean";
  if (scenario === "undeclared-source") contract.arguments[0]!.source_path = contract.correlation[0]!.source_path = ["missing"];
  if (scenario === "undeclared-outcome") contract.outcome.path = ["missing"];
  if (scenario !== "changed-hash") contract.contract_hash = capabilityContractHash(target);
  expect(() => assertOperationReadbackTarget(effect, target)).toThrow();
});
test("source qualification is part of normal effect admission, not advisory prose", () => {
  const { effect, contract } = fixture(); contract.arguments[0]!.source_path = contract.correlation[0]!.source_path = ["missing"];
  expect(() => assertOperationReadbackSources(effect)).toThrow();
  expect(() => supportedOperation(effect)).toThrow("Operation read-back selectors");
});
test.each(["APPLIED", "ABSENT"])("only fresh correlated settled %s evidence receives a definitive classification, never resume/delivery authority", state => {
  const { effect, target, args, result } = fixture(); result.structuredContent.state = state;
  expect(evaluateOperationReadback(effect, target, args, result, prepared, now)).toEqual({ profile: "operation-readback-evaluation/v1", outcome: state === "APPLIED" ? "APPLIED" : "NOT_APPLIED",
    observedAt: result.structuredContent.observedAt, settled: true, evidenceMeaning: "operation-state", canResume: false, noReplay: true, deliveryVerified: false });
});
test.each(["APPLIED", "ABSENT", "PENDING"])("non-settled %s stays unresolved; absence alone is not proof of no effect", state => {
  const { effect, target, args, result } = fixture(); result.structuredContent.state = state; result.structuredContent.settled = false;
  expect(evaluateOperationReadback(effect, target, args, result, prepared, now)).toMatchObject({ outcome: "UNRESOLVED", settled: false });
});
test("a settled unknown state remains unresolved rather than coercing to false", () => {
  const { effect, target, args, result } = fixture(); result.structuredContent.state = "PENDING";
  expect(evaluateOperationReadback(effect, target, args, result, prepared, now)).toMatchObject({ outcome: "UNRESOLVED" });
});
test.each(["wrong-invoice", "wrong-tenant", "text-only", "error-envelope", "nonboolean-error", "string-settlement", "missing-time", "invalid-time", "pre-intent", "future", "stale", "invalid-now", "future-intent", "empty-identity", "missing-source", "oversized-output", "secret-argument"])("unqualified %s cannot establish operation outcome", scenario => {
  const { effect, target, args, result } = fixture(); let envelope: unknown = result, at = now, intentAt = prepared;
  if (scenario === "wrong-invoice") result.structuredContent.invoiceId = "OTHER";
  if (scenario === "wrong-tenant") result.structuredContent.accountId = "OTHER";
  if (scenario === "text-only") envelope = { content: [{ type: "text", text: "Sent successfully" }] };
  if (scenario === "error-envelope") envelope = { ...result, isError: true };
  if (scenario === "nonboolean-error") envelope = { ...result, isError: "false" };
  if (scenario === "string-settlement") (result.structuredContent as any).settled = "true";
  if (scenario === "missing-time") delete (result.structuredContent as any).observedAt;
  if (scenario === "invalid-time") result.structuredContent.observedAt = "not a date";
  if (scenario === "pre-intent") result.structuredContent.observedAt = "2026-10-06T11:59:59.000Z";
  if (scenario === "future") result.structuredContent.observedAt = "2026-10-06T12:00:31.000Z";
  if (scenario === "stale") at = "2026-10-06T12:02:00.000Z";
  if (scenario === "invalid-now") at = "not a date";
  if (scenario === "future-intent") intentAt = "2026-10-06T12:01:00.000Z";
  if (scenario === "empty-identity") args.invoiceId = result.structuredContent.invoiceId = "";
  if (scenario === "missing-source") delete (args as any).invoiceId;
  if (scenario === "oversized-output") { target.bridge_contract!.output_schema!.additionalProperties = true; (result.structuredContent as any).padding = "x".repeat(64_000); effect.operation_contract!.readback!.contract_hash = capabilityContractHash(target); }
  if (scenario === "secret-argument") { effect.input_schema.additionalProperties = true; (args as any).password = "synthetic-secret"; }
  expect(() => evaluateOperationReadback(effect, target, args, envelope, intentAt, at)).toThrow();
});
test("own-field selection cannot use inherited operation identifiers", () => {
  const { effect, target } = fixture(), args = Object.assign(Object.create({ invoiceId: "INV-001" }), { accountId: "TENANT-001" });
  expect(() => resolveOperationReadbackArguments(effect, target, args)).toThrow();
});
test("compiled operation semantics pin the separately reviewed read target without adding an action or granting its role", () => {
  const { effect, target } = fixture(), pins = new Map([[effect.tool_id, pin(effect)], [target.tool_id, pin(target)]]);
  const plan = compileOperationWorkflow(yaml(effect), [effect, target], "Platform Admin", pins);
  expect(plan.ir.root.nodes).toHaveLength(1);
  const node = plan.ir.root.nodes[0]!; expect(node.kind).toBe("action");
  expect(node.kind === "action" ? node.readback : null).toEqual({ profile: "operation-readback-binding/v1", toolId: target.tool_id, contractHash: capabilityContractHash(target), admission: pin(target) });
  expect(target.allowed_roles).toEqual(["ERP Recovery"]);
  pins.set(target.tool_id, { ...pin(target), admissionVersion: 2 });
  expect(compileOperationWorkflow(yaml(effect), [effect, target], "Platform Admin", pins).semanticHash).not.toBe(plan.semanticHash);
});
test.each(["missing-pin", "different-connection", "missing-target", "duplicate-target", "changed-target"])("compilation blocks %s rather than silently omitting or rebinding read-back", scenario => {
  const { effect, target } = fixture(), pins = new Map([[effect.tool_id, pin(effect)], [target.tool_id, pin(target)]]); let tools = [effect, target];
  if (scenario === "missing-pin") pins.delete(target.tool_id);
  if (scenario === "different-connection") pins.set(target.tool_id, { ...pin(target), connectionId: "another-erp" });
  if (scenario === "missing-target") tools = [effect];
  if (scenario === "duplicate-target") tools.push(structuredClone(target));
  if (scenario === "changed-target") target.description = "Unreviewed replacement";
  expect(() => compileOperationWorkflow(yaml(effect), tools, "Platform Admin", pins)).toThrow();
});

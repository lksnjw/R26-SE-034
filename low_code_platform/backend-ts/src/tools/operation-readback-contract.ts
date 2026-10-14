import { z } from "zod";
import { canonicalJSONBytes, resolvedParameterHashBytes } from "../core/canonical-json.js";
import { operationReadbackSchema, type OperationReadbackContract } from "../registry/operation-readback-schema.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { validateToolInput, validateToolSchemaProfile } from "./tool-input-schema.js";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const same = (a: unknown, b: unknown) => canonicalJSONBytes(a).equals(canonicalJSONBytes(b));
const contractHash = (tool: ToolDefinition) => resolvedParameterHashBytes(canonicalJSONBytes(tool));
const iso = z.string().datetime();
function declared(schema: unknown, path: readonly string[], required = false): Record<string, unknown> {
  let current = schema;
  for (const part of path) {
    if (!object(current) || current.type !== "object" || !object(current.properties) || !Object.hasOwn(current.properties, part) ||
        required && (!Array.isArray(current.required) || !current.required.includes(part)))
      throw new Error("Read-back selector must name a declared business field");
    current = current.properties[part];
  }
  if (!object(current)) throw new Error("Read-back selector has no declared type");
  return current;
}
function selected(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!object(current) || !Object.hasOwn(current, part)) throw new Error("Read-back evidence field is absent");
    current = current[part];
  }
  return current;
}
export function operationReadbackContract(effect: ToolDefinition): OperationReadbackContract {
  if (effect.is_read_only || !effect.operation_contract?.readback) throw new Error("No reviewed operation read-back contract exists");
  return operationReadbackSchema.parse(effect.operation_contract.readback);
}
export function assertOperationReadbackSources(effect: ToolDefinition): void {
  const contract = operationReadbackContract(effect);
  if (validateToolSchemaProfile(effect.input_schema).length) throw new Error("Unsupported operation argument schema");
  for (const argument of contract.arguments) declared(effect.input_schema, argument.source_path);
  for (const correlation of contract.correlation) {
    const source = declared(effect.input_schema, correlation.source_path);
    if (!["string", "integer", "number"].includes(String(source.type))) throw new Error("Read-back correlation requires a stable scalar business identifier");
  }
}
/** Cross-tool qualification is deterministic; no discovery or model can
 * substitute a same-named, different, write-capable or schema-less tool. */
export function assertOperationReadbackTarget(effect: ToolDefinition, target: ToolDefinition): OperationReadbackContract {
  assertOperationReadbackSources(effect);
  const contract = operationReadbackContract(effect), output = target.bridge_contract?.output_schema;
  if (target.tool_id !== contract.tool_id || contractHash(target) !== contract.contract_hash || !target.is_read_only ||
      target.operation_contract || target.risk_level.toLowerCase() !== "low" || target.side_effects.length || !target.allowed_roles.length ||
      !target.bridge_contract || !output || output.type !== "object" || validateToolSchemaProfile(output).length || validateToolSchemaProfile(target.input_schema).length)
    throw new Error("Read-back requires its exact reviewed low-risk read/output contract");
  for (const argument of contract.arguments) {
    const source = declared(effect.input_schema, argument.source_path), parameter = declared(target.input_schema, [argument.parameter]);
    if (source.type !== parameter.type && !(source.type === "integer" && parameter.type === "number"))
      throw new Error("Read-back argument mapping changes a declared type");
  }
  if (Array.isArray(target.input_schema.required) && target.input_schema.required.some(key => !contract.arguments.some(item => item.parameter === key)))
    throw new Error("Read-back mapping omits a required business parameter");
  for (const correlation of contract.correlation) {
    const source = declared(effect.input_schema, correlation.source_path), result = declared(output, correlation.result_path, true);
    if (source.type !== result.type) throw new Error("Read-back identity fields must have the same declared type");
  }
  if (declared(output, contract.settled_path, true).type !== "boolean" || declared(output, contract.observed_at_path, true).type !== "string")
    throw new Error("Read-back requires declared settlement and observation-time evidence");
  const outcome = declared(output, contract.outcome.path, true);
  for (const value of [contract.outcome.applied, contract.outcome.not_applied])
    if (outcome.type !== typeof value && !(outcome.type === "integer" && typeof value === "number" && Number.isSafeInteger(value)))
      throw new Error("Read-back outcome does not match its declared scalar type");
  return contract;
}
export function resolveOperationReadbackArguments(effect: ToolDefinition, target: ToolDefinition, originalArguments: Record<string, unknown>): Record<string, unknown> {
  const contract = assertOperationReadbackTarget(effect, target);
  if (validateToolInput(effect.input_schema, originalArguments).length || canonicalJSONBytes(originalArguments).length > 64_000 ||
      !same(originalArguments, withoutSecretFields(originalArguments))) throw new Error("Exact non-secret operation arguments are required");
  const args = Object.fromEntries(contract.arguments.map(item => [item.parameter, structuredClone(selected(originalArguments, item.source_path))]));
  if (validateToolInput(target.input_schema, args).length || canonicalJSONBytes(args).length > 64_000) throw new Error("Resolved read-back arguments are invalid or oversized");
  return args;
}
/** Evaluates already returned structured evidence only. This function neither
 * calls a tool nor proves a transport, grants authorization, closes a case,
 * manufactures an original SDK acknowledgement, or permits replay/resume.
 * Identifier equality does not prove causation or unique send attribution;
 * the reviewed live status contract must establish those business semantics. */
export function evaluateOperationReadback(effect: ToolDefinition, target: ToolDefinition, originalArguments: Record<string, unknown>, envelope: unknown,
  preparedAt: string, now = new Date().toISOString()) {
  const contract = assertOperationReadbackTarget(effect, target);
  resolveOperationReadbackArguments(effect, target, originalArguments);
  if (!iso.safeParse(preparedAt).success || !iso.safeParse(now).success || Date.parse(preparedAt) > Date.parse(now)) throw new Error("Invalid read-back observation window");
  if (!object(envelope) || envelope.isError !== undefined && envelope.isError !== false || !object(envelope.structuredContent) ||
      validateToolInput(target.bridge_contract!.output_schema, envelope.structuredContent).length || canonicalJSONBytes(envelope.structuredContent).length > 64_000)
    throw new Error("Read-back requires a successful bounded structured result; text is not evidence");
  const result = envelope.structuredContent, safeResult = withoutSecretFields(result);
  const read = (path: readonly string[]) => {
    const value = selected(result, path);
    if (!same(value, selected(safeResult, path))) throw new Error("Secret-bearing fields cannot establish read-back evidence");
    return value;
  };
  for (const correlation of contract.correlation) {
    const expected = selected(originalArguments, correlation.source_path), actual = read(correlation.result_path);
    if (!(typeof expected === "string" && expected.trim() && expected.length <= 256 || typeof expected === "number" && Number.isSafeInteger(expected)) || !same(expected, actual))
      throw new Error("Read-back result does not identify the exact original business operation");
  }
  const observedAt = read(contract.observed_at_path);
  if (!iso.safeParse(observedAt).success) throw new Error("Read-back observation time is invalid");
  const observed = Date.parse(observedAt as string), current = Date.parse(now);
  if (observed < Date.parse(preparedAt) || observed > current || current - observed > contract.max_age_seconds * 1000)
    throw new Error("Read-back evidence is stale, pre-intent or from the future");
  const settled = read(contract.settled_path) === true, state = read(contract.outcome.path);
  const outcome = !settled ? "UNRESOLVED" : same(state, contract.outcome.applied) ? "APPLIED" : same(state, contract.outcome.not_applied) ? "NOT_APPLIED" : "UNRESOLVED";
  return { profile: "operation-readback-evaluation/v1" as const, outcome, observedAt: observedAt as string, settled,
    evidenceMeaning: contract.evidence_meaning, canResume: false as const, noReplay: true as const, deliveryVerified: false as const };
}

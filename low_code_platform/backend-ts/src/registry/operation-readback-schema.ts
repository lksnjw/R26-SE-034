import { z } from "zod";
import { isSecretField } from "../redact/secrets.js";

const safePart = z.string().min(1).max(128).refine(value => !["__proto__", "constructor", "prototype"].includes(value) && !isSecretField(value));
const path = z.array(safePart).min(1).max(12);
const scalar = z.union([z.string().min(1).max(256), z.number().finite(), z.boolean()]);
/** Local reviewed contract, not remote discovery, a dispatch permit or an ERP
 * idempotency promise. Definitive absence requires an explicit settled state. */
export const operationReadbackSchema = z.object({
  profile: z.literal("operation-readback-contract/v1"),
  tool_id: z.string().trim().min(1).max(256),
  contract_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  arguments: z.array(z.object({ parameter: safePart.refine(value => value !== "role"), source_path: path }).strict()).min(1).max(32),
  correlation: z.array(z.object({ source_path: path, result_path: path }).strict()).min(1).max(8),
  settled_path: path,
  observed_at_path: path,
  max_age_seconds: z.number().int().min(1).max(300),
  outcome: z.object({ path, applied: scalar, not_applied: scalar }).strict(),
  evidence_meaning: z.literal("operation-state"),
}).strict().superRefine((value, context) => {
  const key = (parts: string[]) => JSON.stringify(parts);
  if (new Set(value.arguments.map(item => item.parameter)).size !== value.arguments.length)
    context.addIssue({ code: "custom", message: "Read-back parameters must be distinct" });
  if (new Set(value.correlation.map(item => key(item.result_path))).size !== value.correlation.length ||
      value.correlation.some(item => !value.arguments.some(argument => key(argument.source_path) === key(item.source_path))))
    context.addIssue({ code: "custom", message: "Each distinct correlation must bind an actual read-back argument" });
  if (value.outcome.applied === value.outcome.not_applied)
    context.addIssue({ code: "custom", message: "Applied and not-applied outcomes must be distinct" });
  const outputs = [value.outcome.path, value.settled_path, value.observed_at_path, ...value.correlation.map(item => item.result_path)].map(key);
  if (new Set(outputs).size !== outputs.length)
    context.addIssue({ code: "custom", message: "Outcome, settlement, freshness and correlation fields must be distinct" });
});
export type OperationReadbackContract = z.infer<typeof operationReadbackSchema>;

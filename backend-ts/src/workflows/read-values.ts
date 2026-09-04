import { z } from "zod";
import type { ReadBinding, ReadReference } from "./compiled-read.js";
import { validateToolSchemaProfile } from "../tools/tool-input-schema.js";

const safe = (value: string) => !["__proto__", "constructor", "prototype"].includes(value);
const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).refine(value => value !== "input" && safe(value));
const path = z.array(z.string().regex(/^[A-Za-z0-9_-]+$/).refine(safe)).max(16);
export const readReferenceSchema: z.ZodType<ReadReference> = z.union([
  z.object({ kind: z.literal("ref"), source: z.literal("workflowInput"), path }).strict(),
  z.object({ kind: z.literal("ref"), source: z.literal("nodeOutput"), nodeId: id, path }).strict(),
]);
export const readBindingSchema: z.ZodType<ReadBinding> = z.lazy(() => z.union([
  readReferenceSchema,
  z.object({ kind: z.literal("literal"), value: z.union([z.string().max(200000), z.number().finite(), z.boolean(), z.null()]) }).strict(),
  z.object({ kind: z.literal("object"), fields: z.record(z.string().refine(safe), readBindingSchema) }).strict(),
  z.object({ kind: z.literal("array"), items: z.array(readBindingSchema).max(200) }).strict(),
  z.object({ kind: z.literal("template"), parts: z.array(z.union([z.string(), readReferenceSchema])).max(200) }).strict(),
]));
export type ReadMerge = { schema: Record<string, unknown>; then: ReadBinding; else: ReadBinding };
export type ReadReturn = { schema: Record<string, unknown>; value: ReadBinding };
const schema = z.record(z.string(), z.unknown()).refine(value => validateToolSchemaProfile(value).length === 0, "Unsupported value schema");
export const mergeSchema: z.ZodType<ReadMerge> = z.object({ schema, then: readBindingSchema, else: readBindingSchema }).strict();
export const returnSchema: z.ZodType<ReadReturn> = z.object({ schema, value: readBindingSchema }).strict();
export function boundReadValue(raw: unknown): void {
  let count = 0;
  const visit = (value: unknown, depth: number) => {
    if (++count > 8192 || depth > 40) throw new Error("Read value exceeds structural limits");
    if (value && typeof value === "object") for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(raw, 0);
}
function boundedSchema<T>(inner: z.ZodType<T>) {
  return z.unknown().transform((raw, ctx) => {
    try { boundReadValue(raw); return inner.parse(raw); }
    catch { ctx.addIssue({ code: "custom", message: "Invalid or oversized typed read value" }); return z.NEVER; }
  });
}
export const readMergeSchema = boundedSchema(mergeSchema);
export const readReturnSchema = boundedSchema(returnSchema);

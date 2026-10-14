import { z } from "zod";

export const safeModelInputName = (value: string) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
export const exactModelInputReference = z.string().min(1).max(1000)
  .regex(/^\{\{[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+\}\}$/)
  .refine(value => !value.startsWith("{{input."), "Model input must come from a prior node output");
export const namedModelInputSchema = z.record(z.string(), exactModelInputReference)
  .refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 8 && Object.keys(value).every(safeModelInputName),
    "Use 1–8 safe named prior-output references");
export const modelInputSchema = z.union([exactModelInputReference, namedModelInputSchema]);
export type ModelInput = z.infer<typeof modelInputSchema>;

import { z } from "zod";
import type { ReadBinding } from "./compiled-read.js";
import type { ReadSequence, ReadControlNode } from "./read-control-flow.js";
import type { ReadIteration } from "./read-interpreter.js";

export type ProtectedMachinePlan = { profile: "protected-machine-plan/v1"; sourceHash: string; semanticHash: string; flow: ReadSequence;
  actions: Array<{ id: string; input: ReadBinding }>; inputSchema?: Record<string, unknown> };
export type ProtectedMachineFault = { code: "ERP_RESOURCE_NOT_FOUND"; failedNodeId: string; failedInvocationId: string };
export type ProtectedMachineSkip = { kind: "branch"; conditionId: string; selected: "then" | "else" } |
  { kind: "return"; returnId: string } | { kind: "empty-collection"; loopId: string } |
  { kind: "body-succeeded"; protectedId: string } | { kind: "body-aborted"; fault: ProtectedMachineFault };
export type ProtectedMachinePoint = { kind: "action" | "condition" | "skip" | "merge" | "return" | "collection-start" | "collection-item" |
  "collection-complete" | "protected-start" | "protected-select" | "protected-complete";
  nodeId: string; invocationId: string; iterations: ReadIteration[]; sequence: number; scope: "invocation" | "unentered-template";
  valid: boolean; arguments?: unknown; value?: unknown; selected?: "then" | "else"; count?: number; reason?: ProtectedMachineSkip;
  outcome?: "SUCCEEDED" | "HANDLED_ERROR" | "RETURNED" | "FAILED"; fault?: ProtectedMachineFault };
export type ProtectedMachineResult = { returned?: string; fault?: ProtectedMachineFault };
type SequenceFrame = { kind: "sequence"; block: number; index: number; result: ProtectedMachineResult };
type ConditionFrame = { kind: "if"; id: string; phase: "predicate" | "selected" | "skip" | "merge" | "finish"; selected?: "then" | "else";
  outer: string[]; result: ProtectedMachineResult; output?: { value: unknown } };
type CollectionFrame = { kind: "foreach"; id: string; phase: "start" | "item" | "body" | "collect" | "complete" | "finish"; outer: string[];
  index: number; collected: unknown[]; items?: unknown[]; budget: { bytes: number; nodes: number }; result: ProtectedMachineResult; output?: { value: unknown } };
type ProtectFrame = { kind: "protect"; id: string; phase: "start" | "body" | "select" | "handler" | "complete" | "finish"; outer: string[];
  result: ProtectedMachineResult; handled: boolean; selectedFault?: ProtectedMachineFault; output?: { value: unknown } };
type SkipFrame = { kind: "skip"; ids: string[]; index: number; reason: ProtectedMachineSkip };
export type ProtectedMachineFrame = SequenceFrame | ConditionFrame | CollectionFrame | ProtectFrame | SkipFrame;
export type ProtectedMachineSnapshot = { profile: "protected-machine/v1"; sourceHash: string; semanticHash: string; sequence: number; visits: number;
  values: Record<string, unknown>; iterations: ReadIteration[]; frames: ProtectedMachineFrame[]; pending?: ProtectedMachinePoint;
  status: "RUNNING" | "DONE" | "FAILED" | "HALTED"; result?: { value: unknown }; failure?: ProtectedMachineFault };
export type StructuralMachineNode = Exclude<ReadControlNode, { kind: "action" }>;

const id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).refine(value => !["input", "__proto__", "constructor", "prototype"].includes(value));
const integer = z.number().int().min(0).max(5000), address = z.string().min(1).max(1100);
const fault = z.object({ code: z.literal("ERP_RESOURCE_NOT_FOUND"), failedNodeId: id, failedInvocationId: address }).strict();
const result = z.object({ returned: id.optional(), fault: fault.optional() }).strict().refine(value => !(value.returned && value.fault));
const output = z.object({ value: z.unknown() }).strict();
const outer = z.array(z.string().max(64)).max(301);
const reason = z.union([
  z.object({ kind: z.literal("branch"), conditionId: id, selected: z.enum(["then", "else"]) }).strict(),
  z.object({ kind: z.literal("return"), returnId: id }).strict(),
  z.object({ kind: z.literal("empty-collection"), loopId: id }).strict(),
  z.object({ kind: z.literal("body-succeeded"), protectedId: id }).strict(),
  z.object({ kind: z.literal("body-aborted"), fault }).strict(),
]);
const iterations = z.array(z.object({ loopId: id, index: z.number().int().min(0).max(99) }).strict()).max(8);
const point = z.object({ kind: z.enum(["action", "condition", "skip", "merge", "return", "collection-start", "collection-item", "collection-complete",
  "protected-start", "protected-select", "protected-complete"]), nodeId: id, invocationId: address, iterations, sequence: integer,
  scope: z.enum(["invocation", "unentered-template"]), valid: z.boolean(), arguments: z.unknown().optional(), value: z.unknown().optional(),
  selected: z.enum(["then", "else"]).optional(), count: z.number().int().min(0).max(32768).optional(), reason: reason.optional(),
  outcome: z.enum(["SUCCEEDED", "HANDLED_ERROR", "RETURNED", "FAILED"]).optional(), fault: fault.optional() }).strict();
const frames = z.array(z.union([
  z.object({ kind: z.literal("sequence"), block: integer, index: integer, result }).strict(),
  z.object({ kind: z.literal("if"), id, phase: z.enum(["predicate", "selected", "skip", "merge", "finish"]), selected: z.enum(["then", "else"]).optional(),
    outer, result, output: output.optional() }).strict(),
  z.object({ kind: z.literal("foreach"), id, phase: z.enum(["start", "item", "body", "collect", "complete", "finish"]), outer,
    index: z.number().int().min(0).max(100), collected: z.array(z.unknown()).max(100), items: z.array(z.unknown()).max(100).optional(),
    budget: z.object({ bytes: z.number().int().min(0).max(1000000), nodes: z.number().int().min(0).max(32768) }).strict(), result, output: output.optional() }).strict(),
  z.object({ kind: z.literal("protect"), id, phase: z.enum(["start", "body", "select", "handler", "complete", "finish"]), outer,
    result, handled: z.boolean(), selectedFault: fault.optional(), output: output.optional() }).strict(),
  z.object({ kind: z.literal("skip"), ids: z.array(id).max(200), index: integer, reason }).strict(),
])).max(40);
export const protectedMachineSnapshotSchema = z.object({ profile: z.literal("protected-machine/v1"),
  sourceHash: z.string().regex(/^sha256:[a-f0-9]{64}$/), semanticHash: z.string().regex(/^sha256:[a-f0-9]{64}$/), sequence: integer, visits: integer,
  values: z.record(z.string(), z.unknown()), iterations, frames, pending: point.optional(), status: z.enum(["RUNNING", "DONE", "FAILED", "HALTED"]),
  result: output.optional(), failure: fault.optional() }).strict();

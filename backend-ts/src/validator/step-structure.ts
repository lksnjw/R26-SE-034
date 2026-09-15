import type { WorkflowBlueprint } from "../models/schemas.js";

type StepStructureResult = {
  schema_ok: boolean;
  errors: string[];
};

const priorOutputReference = /^\{\{\s*([a-zA-Z0-9_-]+)\.(?:output|structuredContent)(?:\.[a-zA-Z0-9_.-]+)?\s*\}\}$/;

function sourceReference(workflow: WorkflowBlueprint, stepIndex: number, input: string | undefined): string | null {
  const sourceID = priorOutputReference.exec((input ?? "").trim())?.[1];
  if (sourceID === undefined) return null;
  return workflow.steps.slice(0, stepIndex).some((prior) => prior.id === sourceID) ? sourceID : `!${sourceID}`;
}

/*******************************************************************************
 * Function: validateAnalysisStepStructure
 *
 * Checks the bounded declarative shape of one structured analysis step. This
 * function performs no provider admission, model call, publication, or runtime
 * authorization.
 ******************************************************************************/
export function validateAnalysisStepStructure(
  workflow: WorkflowBlueprint,
  stepIndex: number,
  result: StepStructureResult,
): void {
  const step = workflow.steps[stepIndex];
  if (step === undefined) return;
  if ((step.instruction ?? "").trim() === "") {
    result.schema_ok = false;
    result.errors.push(`ANALYSIS_INSTRUCTION_REQUIRED: step ${step.id} requires instruction`);
  }
  if ((step.max_input_items ?? 0) < 0 || (step.max_input_chars ?? 0) < 0 || (step.max_output_tokens ?? 0) < 0) {
    result.schema_ok = false;
    result.errors.push(`ANALYSIS_INPUT_LIMIT_INVALID: step ${step.id} has a negative input limit`);
  }
  if (!step.output_schema || step.output_schema.type !== "object") {
    result.schema_ok = false;
    result.errors.push(`ANALYSIS_OUTPUT_SCHEMA_REQUIRED: step ${step.id} requires an object output_schema`);
  }
  if (!step.data_class) {
    result.schema_ok = false;
    result.errors.push(`ANALYSIS_DATA_CLASS_REQUIRED: step ${step.id} requires data_class`);
  }
  const source = sourceReference(workflow, stepIndex, step.input);
  if (source === null) {
    result.schema_ok = false;
    result.errors.push(`ANALYSIS_INPUT_INVALID: step ${step.id} input must reference prior output`);
  } else if (source.startsWith("!")) {
    result.schema_ok = false;
    result.errors.push(`ANALYSIS_INPUT_SOURCE_UNDECLARED: step ${step.id} references ${source.slice(1)}`);
  }
}

/*******************************************************************************
 * Function: validateAgentStepStructure
 *
 * Checks the declarative bounds of a runtime agent step. Exact reviewed tool
 * contracts, roles, model egress and arguments remain separate gates.
 ******************************************************************************/
export function validateAgentStepStructure(
  workflow: WorkflowBlueprint,
  stepIndex: number,
  result: StepStructureResult,
): void {
  const step = workflow.steps[stepIndex];
  if (step === undefined) return;
  const fail = (code: string, message: string) => {
    result.schema_ok = false;
    result.errors.push(`${code}: ${message}`);
  };
  if (!(step.instruction ?? "").trim()) fail("AGENT_INSTRUCTION_REQUIRED", `step ${step.id} requires instruction`);
  if (!Array.isArray(step.allowed_actions) || step.allowed_actions.length < 1 || step.allowed_actions.length > 8 || new Set(step.allowed_actions).size !== step.allowed_actions.length)
    fail("AGENT_ALLOWLIST_INVALID", `step ${step.id} requires 1–8 unique actions`);
  if (!step.output_schema || step.output_schema.type !== "object") fail("AGENT_OUTPUT_SCHEMA_REQUIRED", `step ${step.id} requires an object output_schema`);
  if (!step.completion_predicate || !Array.isArray(step.completion_predicate.path) || !Object.hasOwn(step.completion_predicate, "equals"))
    fail("AGENT_COMPLETION_REQUIRED", `step ${step.id} requires an exact completion_predicate`);
  if (!step.data_class) fail("AGENT_DATA_CLASS_REQUIRED", `step ${step.id} requires data_class`);
  const source = sourceReference(workflow, stepIndex, step.input);
  if (source === null) fail("AGENT_INPUT_INVALID", `step ${step.id} input must reference prior output`);
  else if (source.startsWith("!")) fail("AGENT_INPUT_SOURCE_UNDECLARED", `step ${step.id} references ${source.slice(1)}`);
  const bounds = [step.max_input_items, step.max_input_chars, step.max_output_tokens, step.max_total_tokens, step.max_rounds, step.max_tool_calls, step.max_wall_time_ms]
    .filter((value) => value !== undefined);
  if (bounds.some((value) => !Number.isInteger(value) || value! < 0) || step.max_concurrency !== undefined && step.max_concurrency !== 1)
    fail("AGENT_LIMIT_INVALID", `step ${step.id} has unsupported execution limits`);
}

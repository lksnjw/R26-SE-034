import type { CandidateValidationResult, RegistryValidator } from "../validator/registry-validator.js";
import type { ToolDefinition } from "../registry/schemas.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { inspectWorkflowDraft } from "./compiled-read.js";

/** Preview/save validation, not execution admission. Preserve invalid user
 * mappings as explicitly blocked drafts; never call discovery or a model here. */
export function validateWorkspaceDraft(candidateId: string, yaml: string, role: string, validator: RegistryValidator, tools: readonly ToolDefinition[]) {
  const result = validator.validatePlan(candidateId, yaml, role);
  let issues: string[] = [];
  try {
    const blueprint = parseWorkflowYAMLStrict(yaml);
    // Flat tool plans need the same literal-type and unique-ID checks as
    // structured plans. A generic registry PASS is not a compiler PASS.
    issues = inspectWorkflowDraft(blueprint, tools, role).issues;
    if (blueprint.metadata?.controlFlow === undefined && !issues.length) return result;
  } catch {
    issues = ["Structural draft cannot be compiled within supported limits"];
  }
  return withWorkspaceCompilationIssues(result, issues);
}

/** Apply pure compiler diagnostics to the public validation projection. A
 * registry-only PASS cannot hide an invalid model binding or execution shape. */
export function withWorkspaceCompilationIssues(result: CandidateValidationResult, issues: string[]) {
  result.metadata.workspace_compilation = { profile: "workspace-read-compilation/v1", issues: [...new Set(issues)] };
  if (issues.length) {
    result.score = Math.max(0, Math.round((result.score - (result.schema_ok ? 0.2 : 0)) * 100) / 100);
    result.schema_ok = false;
    result.passed = false;
    result.failed_rules = [...new Set([...result.failed_rules, "WORKSPACE_READ_COMPILATION"])].sort();
    result.errors = [...new Set([...result.errors, ...issues.map(issue => `WORKSPACE_READ_COMPILATION: ${issue}`)])];
  }
  return result;
}

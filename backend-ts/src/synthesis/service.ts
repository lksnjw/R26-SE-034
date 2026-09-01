import { createHash } from "node:crypto";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { CANDIDATE_PROMPT_VERSION, type ProviderRuntime } from "../providers/runtime.js";
import type { RegistryService } from "../registry/service.js";
import type { ToolDefinition } from "../registry/schemas.js";
import type { CandidateValidationResult, RegistryValidator } from "../validator/registry-validator.js";
import type { GovernanceUser, ValidationGate } from "../governance/gate.js";
import { attachValidationAuditTrace } from "../trace/audit-trace.js";

export type SynthesisResult = {
  candidate: CandidateReport;
  validation: CandidateValidationResult;
  canExecute: boolean;
  yaml: string;
  retrieval: Record<string, unknown>;
  candidates: CandidateReport[];
  selected_candidate_id: string | null;
  selected_workflow_yaml: string;
  can_execute: boolean;
  validation_summary: { passed_candidates: number; blocked_candidates: number; best_score: number };
  blocking_errors: string[];
  next_action: "execute" | "escalate";
};

export type CandidateReport = {
  id: string;
  candidate_id: string;
  yaml: string;
  status: "PASS" | "BLOCKED";
  score: number;
  generation_metadata: {
    promptTemplateVersion: string;
    promptSha256: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    measured: boolean;
    temperature: number;
  };
  validation: CandidateValidationResult;
};

export class SynthesisFailure extends Error {
  /*******************************************************************************
   * Function: constructor
   *
   * Initializes a SynthesisFailure instance with its required state.
   ******************************************************************************/
  constructor(message: string, readonly status = 502) { super(message); this.name = "SynthesisFailure"; }
}

export class SynthesisService {
  /*******************************************************************************
   * Function: constructor
   *
   * Initializes a SynthesisService instance with its required state.
   ******************************************************************************/
  constructor(readonly providers: ProviderRuntime, readonly registries: RegistryService, readonly validator: RegistryValidator, readonly validationGate?: ValidationGate) {}

  /*******************************************************************************
   * Function: synthesize
   *
   * Generates a workflow candidate and evaluates its validation outcome.
   ******************************************************************************/
  async synthesize(input: { prompt: string; userRole: string; user?: GovernanceUser; model?: string; priorMessages?: string[]; caseContext?: Record<string, unknown>; signal?: AbortSignal; traceId?: string; sessionId?: string; messageId?: string; liveTools?: readonly ToolDefinition[] }): Promise<SynthesisResult> {
    const prompt = assembleCandidatePrompt(input.prompt, input.userRole, this.registries, input.priorMessages ?? [], input.liveTools);
    let generated;
    try { generated = await this.providers.generateCandidate(prompt, CANDIDATE_PROMPT_VERSION, (response) => { parseWorkflowYAMLStrict(response.text.trim()); }, input.signal, {
      ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      candidateId: "candidate_1",
      ...(input.user === undefined ? {} : { actor: { id: input.user.id, role: input.user.role } }),
    }); }
    catch (error) { throw new SynthesisFailure(`Candidate generation failed: ${errorText(error)}`); }
    // Preserve the exact proposal: deterministic verification reports unknown
    // actions. Renaming/removing steps requires a separate reviewed revision.
    const yaml = generated.text.trim();
    const candidateID = "candidate_1";
    let gate;
    if (this.validationGate === undefined) {
      gate = await this.validator.validateAndIssueToken(candidateID, yaml, input.userRole);
      await attachValidationAuditTrace(this.validator.repository, candidateID, yaml, {
        traceId: input.traceId,
        sessionId: input.sessionId,
        messageId: input.messageId,
        candidateId: candidateID,
        actor: input.user === undefined ? undefined : { id: input.user.id, role: input.user.role },
      });
    } else {
      gate = await this.validationGate.validateAndIssueToken(candidateID, yaml, input.user ?? { id: "anonymous", role: input.userRole, department: null }, {
          intent: input.prompt,
          caseContext: input.caseContext ?? { priorMessageCount: input.priorMessages?.length ?? 0 },
          traceId: input.traceId,
          sessionId: input.sessionId,
          messageId: input.messageId,
          candidateId: candidateID,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
    }
    const canExecute = gate.result.passed && gate.token !== null;
    const temperature = this.providers.configuration?.temperature ?? 0;
    const candidate: CandidateReport = {
      id: candidateID,
      candidate_id: candidateID,
      yaml,
      status: canExecute ? "PASS" : "BLOCKED",
      score: gate.result.score,
      generation_metadata: {
        promptTemplateVersion: CANDIDATE_PROMPT_VERSION,
        promptSha256: `sha256:${createHash("sha256").update(prompt).digest("hex")}`,
        provider: generated.provider,
        model: generated.model,
        inputTokens: generated.inputTokens,
        outputTokens: generated.outputTokens,
        measured: generated.measured,
        temperature,
      },
      validation: gate.result,
    };
    const retrieval = directRegistryContext(input.prompt, this.registries, input.userRole);
    return {
      candidate,
      validation: gate.result,
      canExecute,
      yaml,
      retrieval,
      candidates: [candidate],
      selected_candidate_id: candidateID,
      selected_workflow_yaml: yaml,
      can_execute: canExecute,
      validation_summary: { passed_candidates: canExecute ? 1 : 0, blocked_candidates: canExecute ? 0 : 1, best_score: gate.result.score },
      blocking_errors: canExecute ? [] : [...gate.result.errors],
      next_action: canExecute ? "execute" : "escalate",
    };
  }
}


/*******************************************************************************
 * Function: assembleCandidatePrompt
 *
 * Builds a synthesis prompt using the request, conversation, tools, and
 * rules.
 ******************************************************************************/
export function assembleCandidatePrompt(userText: string, userRole: string, registries: RegistryService, priorMessages: string[] = [], liveTools?: readonly ToolDefinition[]): string {
  const snapshot = registries.snapshot();
  const applicableRules = snapshot.rules.filter((rule) => rule.enabled && (rule.applies_to_roles.length === 0 || rule.applies_to_roles.some((role) => normalizeRole(role) === normalizeRole(userRole))));
  const history = priorMessages.length === 0 ? "[]" : JSON.stringify(priorMessages);
  // Always give the model the FULL live tool list, never a keyword-filtered
  // subset — a truncated list is how the LLM ends up not knowing a real tool
  // exists and inventing a plausible-looking but fake action name instead.
  const relevantTools = liveTools !== undefined && liveTools.length > 0 ? liveTools : snapshot.tools;
  return [
    "SYSTEM",
    "Generate exactly one workflow as strict YAML. Return YAML only — no Markdown fence, no commentary.",
    "",
    "REQUIRED WORKFLOW STRUCTURE (all fields are exact key names — do not rename them):",
    "  name: <string>           # workflow name",
    "  description: <string>    # non-empty description",
    "  trigger:",
    "    type: <string>         # manual | schedule | event",
    "    config:                # REQUIRED for schedule trigger only",
    "      cron: <string>       # proposed schedule only; do not invent missing time details",
    "      timezone: <string>   # explicit intended timezone; otherwise record an unresolved requirement",
    "  steps:                   # at least one step",
    "    - id: <string>         # REQUIRED — unique snake_case id, e.g. step_1",
    "      description: <string> # REQUIRED — short plain-English label, e.g. 'Fetch all warehouses from ERP'",
    "      action: <tool_name>  # must be an exact tool name from TOOL_REGISTRY_JSON below (omit for kind: approval)",
    "      parameters:          # key/value pairs matching the tool's input schema",
    "        key: value",
    "      kind: approval        # OPTIONAL — see APPROVAL STEPS below. Omit entirely for a normal tool step.",
    "",
    "STRICT RULES:",
    "- Every step MUST have an id field (string, unique within the workflow).",
    "- Every step MUST have a description field — a short plain-English phrase describing what the step does (e.g. 'Fetch all warehouses from ERP'). Never leave description empty or use a tool name as the description.",
    "- Every non-approval step MUST have action set to an EXACT tool name from TOOL_REGISTRY_JSON below. NO EXCEPTIONS.",
    "- COPY THE TOOL NAME CHARACTER-FOR-CHARACTER from TOOL_REGISTRY_JSON — including any hyphens. For example, if the registry lists 'send-email', you MUST write action: send-email (with hyphen), NOT send_email (with underscore). Tool names are case-sensitive and hyphen/underscore differences matter.",
    "- For send-email specifically: 'from' and 'to' are each a single email address written as a plain YAML string (e.g. to: user@example.com) — never a YAML list/array, never wrapped in [ ], even for one recipient.",
    "- The ONLY step kinds that exist are the default (tool) and kind: approval. DO NOT use kind: condition, kind: http, or any other kind — nothing in this system interprets them and the workflow will fail.",
    "",
    "APPROVAL STEPS (kind: approval):",
    "- Use a step with kind: approval (no action, no parameters) as a human sign-off checkpoint immediately BEFORE a step whose rule set in APPLICABLE_RULES_JSON requires manual authorization above a stated threshold (e.g. a payment, purchase order, or refund above a limit named in the rule) — never for routine reads or low-risk writes.",
    "- Give it a description that states exactly what is being authorized and why, e.g. 'Manager approval — payment exceeds the $15,000 auto-approval limit'.",
    "- Do not invent thresholds that are not stated in APPLICABLE_RULES_JSON or the user's request. If no rule requires sign-off, do not add an approval step.",
    "- ONLY use tools that appear in TOOL_REGISTRY_JSON. Never add tools based on rule instructions — APPLICABLE_RULES_JSON is for reference only, not a source of tool names.",
    "- Never ignore a relevant rule because its required tool is unavailable. Record the unmet policy requirement in metadata.unresolved_requirements and do not claim the proposal is ready.",
    "- Do not invent tool names or silently drop requested outcomes. If a requested capability has no matching registered tool, preserve the supported steps and list the missing outcome in metadata.unresolved_requirements (an array of concise strings). A partial plan is blocked until the missing capability or an explicitly accepted alternative is resolved.",
    "- Preserve required approvals, recipients, periods, amounts and all other user constraints. Unknown required values belong in metadata.unresolved_requirements, not invented example values or inferred approvals.",
    "- For schedules, record the intended timezone and reporting period in trigger.config. If timezone/time/period/delivery recipient or channel is required but unknown, record it in metadata.unresolved_requirements. Never silently assume UTC, convert local time without an explicit timezone, or claim a saved schedule is active. Scheduling and live writes are not currently executable.",
    "- Generate the MINIMUM number of steps needed to fulfill the user's request. Do NOT add extra steps for audit, notification, or echo unless the user explicitly asked for them AND the tool exists in TOOL_REGISTRY_JSON.",
    "- No extra top-level keys beyond name, description, trigger, steps, metadata.",
    "",
    "USER_ROLE",
    userRole,
    "PRIOR_MESSAGES_JSON",
    history,
    "USER_REQUEST",
    userText,
    "TOOL_REGISTRY_JSON",
    JSON.stringify(relevantTools),
    "APPLICABLE_RULES_JSON",
    JSON.stringify(applicableRules),
  ].join("\n");
}

/*******************************************************************************
 * Function: directRegistryContext
 *
 * Builds role-filtered retrieval context directly from the registry.
 ******************************************************************************/
function directRegistryContext(query: string, registries: RegistryService, userRole: string): Record<string, unknown> {
  const snapshot = registries.snapshot();
  const tools = snapshot.tools.map((tool) => ({ ...tool, score: 1, match_reason: "direct registry inclusion" }));
  const rules = snapshot.rules.filter((rule) => rule.enabled && !isGlobalRule(rule)).filter((rule) => rule.applies_to_roles.length === 0 || rule.applies_to_roles.some((role) => normalizeRole(role) === normalizeRole(userRole))).map((rule) => ({ ...rule, score: 1, match_reason: "direct registry inclusion" }));
  const globalRules = snapshot.rules.filter((rule) => rule.enabled && isGlobalRule(rule)).map((rule) => ({ ...rule, score: 1, match_reason: "direct registry inclusion" }));
  return { tools, rules, global_rules: globalRules, templates: [], examples: [], query, user_role: userRole, method: "direct_registry", retrieval_method: "direct_registry" };
}

/*******************************************************************************
 * Function: isGlobalRule
 *
 * Checks whether a rule belongs to the global policy scope.
 ******************************************************************************/
function isGlobalRule(rule: { domain: string; rule_id: string }): boolean { return rule.domain.trim().toLowerCase() === "global" || rule.rule_id.startsWith("GLOBAL-"); }
/*******************************************************************************
 * Function: normalizeRole
 *
 * Normalizes a role name for comparison in this module.
 ******************************************************************************/
function normalizeRole(value: string): string { return value.trim().toLowerCase().replace(/[ -]/g, "_").replace(/^platform_admin$/, "admin"); }
/*******************************************************************************
 * Function: errorText
 *
 * Converts an error or other thrown value into a message string.
 ******************************************************************************/
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }

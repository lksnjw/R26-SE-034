import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { CANDIDATE_PROMPT_VERSION, type ProviderRuntime } from "../providers/runtime.js";
import { promptData, generationPromptHash } from "../prompts/contracts.js";
import type { RegistryService } from "../registry/service.js";
import type { ToolDefinition } from "../registry/schemas.js";
import type { CandidateValidationResult, RegistryValidator } from "../validator/registry-validator.js";
import type { GovernanceUser, ValidationGate } from "../governance/gate.js";
import { attachValidationAuditTrace } from "../trace/audit-trace.js";
import { buildReadIR } from "../workflows/compiled-read.js";

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
  execution_profile_issues: string[];
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
  async synthesize(input: { prompt: string; userRole: string; user?: GovernanceUser; model?: string; providerRuntime?: ProviderRuntime; priorMessages?: string[]; caseContext?: Record<string, unknown>; candidateContext?: Record<string, unknown>; candidateValidator?: (yaml: string) => void; signal?: AbortSignal; traceId?: string; sessionId?: string; messageId?: string; liveTools?: readonly ToolDefinition[] }): Promise<SynthesisResult> {
    const baseProvider = input.providerRuntime ?? this.providers;
    const providers = baseProvider.snapshot?.(input.model) ?? baseProvider;
    const prompt = assembleCandidatePrompt(input.prompt, input.userRole, this.registries, input.priorMessages ?? [], input.liveTools, input.candidateContext);
    let generated;
    try { generated = await providers.generateCandidate(prompt, CANDIDATE_PROMPT_VERSION, (response) => {
      const yaml = response.text.trim(); parseWorkflowYAMLStrict(yaml); input.candidateValidator?.(yaml);
    }, input.signal, {
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
    const blueprint = parseWorkflowYAMLStrict(yaml);
    const executionIssues = blueprint.metadata?.controlFlow === undefined ? [] : buildReadIR(blueprint, input.liveTools ?? this.registries.snapshot().tools, input.userRole).issues;
    const canExecute = gate.result.passed && gate.token !== null && executionIssues.length === 0;
    const temperature = providers.configuration?.temperature ?? 0;
    const candidate: CandidateReport = {
      id: candidateID,
      candidate_id: candidateID,
      yaml,
      status: canExecute ? "PASS" : "BLOCKED",
      score: gate.result.score,
      generation_metadata: {
        promptTemplateVersion: CANDIDATE_PROMPT_VERSION,
        promptSha256: generationPromptHash(prompt, CANDIDATE_PROMPT_VERSION),
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
      blocking_errors: canExecute ? [] : [...gate.result.errors, ...executionIssues],
      execution_profile_issues: executionIssues,
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
export function assembleCandidatePrompt(userText: string, userRole: string, registries: RegistryService, priorMessages: string[] = [], liveTools?: readonly ToolDefinition[], candidateContext?: Record<string, unknown>): string {
  const snapshot = registries.snapshot();
  const applicableRules = snapshot.rules.filter((rule) => rule.enabled && (rule.applies_to_roles.length === 0 || rule.applies_to_roles.some((role) => normalizeRole(role) === normalizeRole(userRole))));
  // An explicitly empty live catalog is unavailable, not a reason to fall
  // back to registered tools that this connection did not advertise.
  return promptData({ USER_ROLE: userRole, PRIOR_MESSAGES_JSON: priorMessages, USER_REQUEST: userText,
    TOOL_REGISTRY_JSON: liveTools ?? snapshot.tools, APPLICABLE_RULES_JSON: applicableRules,
    ...(candidateContext === undefined ? {} : { SERVER_DERIVED_CONTEXT_JSON: candidateContext }) });
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

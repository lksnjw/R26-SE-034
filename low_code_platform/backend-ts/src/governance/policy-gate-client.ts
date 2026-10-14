import { boundedJSONRequest, InvalidResponseJSON } from "../core/bounded-json-request.js";
import { OperationDeadlineExceeded } from "../core/bounded-operation.js";
import { z } from "zod";
import type { GovernanceRequest } from "./adapter.js";

const policyGateResponseSchema = z.object({
  request_id: z.string().optional(),
  decision: z.string(),
  reason: z.string().optional(),
  conditions: z.array(z.unknown()).optional(),
  citations: z.array(z.string()).optional(),
}).strict();

export type PolicyGateOutcome =
  | { outcome: "allow"; reason: string; conditions: string[] }
  | { outcome: "deny"; reason: string }
  | { outcome: "review"; reason: string }
  | { outcome: "fallback"; reason: string };

export type PolicyGateClientConfig = {
  url: string;
  apiKey: string;
  timeoutMs: number;
  fetchImplementation?: typeof fetch;
};

export class PolicyGateClient {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  /*******************************************************************************
   * Function: constructor
   *
   * Initializes a PolicyGateClient instance with its required state.
   ******************************************************************************/
  constructor(config: PolicyGateClientConfig) {
    this.#baseUrl = config.url.trim().replace(/\/+$/, "");
    this.#apiKey = config.apiKey.trim();
    this.#timeoutMs = config.timeoutMs;
    this.#fetch = config.fetchImplementation ?? fetch;
    if (!this.#baseUrl || !this.#apiKey) throw new Error("Policy gate URL and API key are required");
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0 || this.#timeoutMs > 2_147_483_647)
      throw new Error("Policy gate timeout must be a positive supported integer");
  }

  /*******************************************************************************
   * Function: evaluate
   *
   * Sends a request to the external policy gate and parses its decision.
   ******************************************************************************/
  async evaluate(request: GovernanceRequest, signal?: AbortSignal): Promise<PolicyGateOutcome> {
    let decoded: unknown;
    try {
      const result = await boundedJSONRequest(this.#fetch, `${this.#baseUrl}/api/policy/evaluate`, {
        method: "POST", headers: { "X-API-Key": this.#apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: buildPrompt(request),
          actor: { user_id: request.user.id, role: request.user.role, department: request.user.department ?? "general" },
          context: { ...request.caseContext, request_id: request.requestId, proposed_actions: request.proposedActions },
        }), ...(signal === undefined ? {} : { signal }),
      }, this.#timeoutMs, "Policy gate response");
      if (!result.response.ok) return [401, 403].includes(result.response.status)
        ? { outcome: "deny", reason: `policy gate authorization failed (HTTP ${result.response.status})` }
        : { outcome: "fallback", reason: `policy gate returned HTTP ${result.response.status}` };
      decoded = result.decoded;
    } catch (error) {
      if (signal?.aborted) return { outcome: "deny", reason: "policy evaluation was cancelled" };
      if (error instanceof InvalidResponseJSON) return { outcome: "deny", reason: "policy gate response was not valid JSON" };
      return { outcome: "fallback", reason: error instanceof OperationDeadlineExceeded ? "policy gate request timed out" : "policy gate is unreachable" };
    }
    const parsed = policyGateResponseSchema.safeParse(decoded);
    if (!parsed.success) {
      return { outcome: "deny", reason: "policy gate response did not match expected schema" };
    }

    if (parsed.data.request_id !== undefined && parsed.data.request_id !== request.requestId)
      return { outcome: "deny", reason: "policy gate request binding did not match" };
    const { decision, reason = "policy gate decision" } = parsed.data;
    if ((parsed.data.conditions?.length ?? 0) > 0 && decision === "allow")
      return { outcome: "review", reason: "Policy conditions require enforceable review before execution" };

    switch (decision) {
      case "allow":
        return { outcome: "allow", reason, conditions: [] };
      case "allow_with_conditions":
        return { outcome: "review", reason: "Conditional policy approval is not executable until its conditions are enforced" };
      case "deny":
        return { outcome: "deny", reason };
      case "review":
        return { outcome: "review", reason };
      default:
        return { outcome: "deny", reason: "policy gate returned an unrecognised decision" };
    }
  }
}

/*******************************************************************************
 * Function: buildPrompt
 *
 * Builds a policy-evaluation prompt from the governance request.
 ******************************************************************************/
function buildPrompt(request: GovernanceRequest): string {
  const parts: string[] = [
    `User intent: ${request.intent}`,
    `Proposed workflow actions: ${request.proposedActions.join(", ") || "none"}`,
  ];
  if (Object.keys(request.caseContext).length > 0) {
    parts.push(`Context: ${JSON.stringify(request.caseContext)}`);
  }
  return parts.join(". ");
}

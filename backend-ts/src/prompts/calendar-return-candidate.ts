/** Static v16 extension only; historical v15 instruction bytes stay intact.
 * No workflow, registry, tool response or user text belongs in this channel. */
export function calendarReturnCandidatePrompt(historical: string): string {
  return historical.replaceAll("(prompt/candidate/v15)", "(prompt/candidate/v16)")
    .replace("TYPED MANUAL OPERATION ANSWERS", "TYPED OPERATION ANSWERS")
    .replace("When the requested manual workflow needs an explicit final answer", "When the requested manual or supported calendar workflow needs an explicit final answer")
    .replace("Recurring/calendar composition does NOT support Return nodes.", "Recurring/calendar composition supports explicit Return nodes under the exact calendar contract below.")
    .replace("Keep unsupported recurring-return intent unresolved.", "Keep unsupported recurring intent unresolved.")
    .replace("Calendar activation does NOT support typed merges or Return nodes.", "Calendar activation supports explicit Return nodes but does NOT support typed branch merges.")
    .replace("Keep requested calendar handoffs unresolved", "Keep requested calendar branch handoffs unresolved") + `

CALENDAR FINAL ANSWERS: REACHABLE WORK AND INDEPENDENT APPROVAL
For explicitly requested final answers in recurring report/delivery drafts, retain trigger.type manual, automation_request, exact requested resources, recipient, conditional wording and all unresolved review/activation requirements. Use read-control-flow/v2 with action, declared boolean if without merge, and typed Return nodes. Every possible delivery must have its own preceding complete reviewed report or exact primary/related report pair in scope. Report windows/pagination stay server-owned, data classes and provider budgets unchanged. Branch-local sources do not escape to a sibling or parent.
A Return ends the whole selected occurrence, not just its branch. Requested delivery must appear before its terminal answer; reject work or answers beyond an unconditional Return or a condition whose both branches Return. A path that terminates cannot also execute later parent work. Do not erase a requested effect with an early answer, infer an unrequested predicate or replace report completeness with a summary. Empty no-delivery outcomes need explicit intended semantics. Calendar branch merges, model collections, subflows and custom retry/error scopes remain unresolved and unsupported.
When returning effect status, use only its declared confirmed output and preserve its evidence meaning: operation acceptance is not delivery proof. A paused, denied, failed or uncertain effect produces no later successful Return. No typed answer grants publication, activation, model egress, approval or dispatch authority. Preserve original prompt identities; emit an editable proposal only, not a running calendar or delivery claim.`;
}

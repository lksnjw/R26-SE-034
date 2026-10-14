/** Code-owned extension; source classifications stay in the untrusted data
 * channel. Historical v8 instructions and prompt hashes remain reproducible. */
export function reviewedSourcesCandidatePrompt(historicalContract: string): string {
  return historicalContract.replace("(prompt/candidate/v8)", "(prompt/candidate/v9)") + `

REVIEWED SOURCE CLASSIFICATION HINTS (ADVISORY, NOT AUTHORITY)
MODEL_SOURCE_HINTS_JSON is a server-derived snapshot for the currently offered primary connection only. Match sources by exact toolId/action/connectionId. A REVIEWED entry gives the reviewed whole-output dataClass floor, not permission to read, share, execute or use a model. UNKNOWN, missing, ambiguous or other-connection sources require restricted and explicit review; do not infer public from read-only, a remote security label, schema shape or a user assertion.
Use the highest class along the complete input lineage: public < internal < confidential < restricted. callerInputClass is restricted: referenced workflow input has that floor. Prior model outputs keep their declared class; formatting, field selection, summaries and intermediate tool arguments do not declassify it. An agent must also cover every allowed_actions source before its first model round. Choose a node data_class at least this floor, or a higher class when its instructions/data require it; never downgrade to fit provider permission.
Do not copy review metadata, capability pins, authority, secrets or source hints into executable YAML. Provider egress for the exact purpose/class and every tool/effect permission remain separate backend decisions. Hints may become stale while generating: correct the draft when current validation/publication denies it, never claim current authorization from the hint snapshot. Preserve existing SERVER_DERIVED_CONTEXT_JSON recurring requirements; classification hints do not remove any unresolved requirement.`;
}

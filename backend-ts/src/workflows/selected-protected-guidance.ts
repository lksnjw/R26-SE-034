import type { readAuthoringContract } from "./read-authoring.js";

/** Same non-authoritative scoped hints for direct and durable saved-chat proposals. */
export function selectedProtectedGuidance(nodeId: string, authoring: ReturnType<typeof readAuthoringContract> | undefined) {
  const group = authoring?.protectedGroups?.find(item => item.nodeId === nodeId);
  return { protectedGroupPatchVersion: group?.patchVersion ?? null,
    allowedProtectedSources: group?.outputSources ?? { success: [], handled: [] } };
}

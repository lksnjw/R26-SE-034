import type { readAuthoringContract } from "./read-authoring.js";

/** Shared, untrusted authoring hints for both saved-chat and direct proposals.
 * The compiler remains authoritative; source suggestions are not receipts. */
export function selectedConditionGuidance(nodeId: string, authoring: ReturnType<typeof readAuthoringContract> | undefined) {
  const condition = authoring?.conditions?.find(item => item.nodeId === nodeId);
  return {
    allowedBooleanSources: condition?.dataSources ?? [],
    allowedMergeSources: condition?.mergeSources ?? { then: [], else: [] },
    mergeNodesSupported: !!authoring && "mergeNodesSupported" in authoring && authoring.mergeNodesSupported === true,
  };
}

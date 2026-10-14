// Bounded source projection only. Execution and error selection stay server-owned.
export function flowProtectedGroups(flow) {
  const result = []; let count = 0;
  const visit = (block, depth) => {
    if (depth > 8 || !Array.isArray(block?.nodes)) return;
    for (const node of block.nodes) {
      if (++count > 300) return;
      if (node?.kind === "protect") { result.push(node); visit(node.body, depth + 1); visit(node.handler, depth + 1); }
      else if (node?.kind === "if") { visit(node.then, depth + 1); visit(node.else, depth + 1); }
      else if (node?.kind === "foreach") visit(node.body, depth + 1);
    }
  };
  visit(flow, 0); return result;
}

export function isOperationProfile(profile) {
  return ["sequential-operation-v1", "protected-operation-v1", "protected-draft-runtime-pending"].includes(profile);
}

export const protectedGroupPatchVersion = "prompt/protected-group-patch/v1";
export const protectedChatUnavailable = "Protected-group chat guidance is unavailable for this draft. Refresh the workspace, edit its output mappings in the canvas, or select a child node. Your text is kept; no general request is sent.";

import type { ReadSequence } from "./read-control-flow.js";

/** Denial-only lexical reachability for calendar decisions and Returns.
 * Keep continuing and terminated effect bounds separate: an early answer
 * cannot make a later effect look reachable or count two exclusive effects
 * as one executable path. No predicate evaluation or path enumeration. */
export function decisionReturnScopes(root: ReadSequence, effectIds: ReadonlySet<string> = new Set()) {
  const predecessors = new Map<string, ReadonlySet<string>>(), unreachable = new Set<string>();
  let hasCondition = false, visits = 0;
  type Bounds = { continuing: number | null; terminated: number | null };
  const maximum = (...values: Array<number | null>): number | null => {
    const present = values.filter((value): value is number => value !== null);
    return present.length ? Math.max(...present) : null;
  };
  const visit = (block: ReadSequence, inherited: ReadonlySet<string>, canEnter: boolean, depth = 0): Bounds => {
    if (depth > 8) throw new Error("Calendar composition exceeds eight nested scopes");
    const visible = new Set(inherited);
    let continuing: number | null = canEnter ? 0 : null, terminated: number | null = null;
    for (const node of block.nodes) {
      if (++visits > 2000) throw new Error("Calendar composition exceeds its structural visit budget");
      if (node.kind === "action") {
        if (continuing === null) unreachable.add(node.nodeId);
        else { predecessors.set(node.nodeId, new Set(visible)); visible.add(node.nodeId); if (effectIds.has(node.nodeId)) continuing++; }
      } else if (node.kind === "return") {
        if (continuing === null) unreachable.add(node.id);
        terminated = maximum(terminated, continuing); continuing = null;
      } else if (node.kind === "if" && !node.merge) {
        hasCondition = true;
        const yes = visit(node.then, visible, continuing !== null, depth + 1), no = visit(node.else, visible, continuing !== null, depth + 1);
        if (continuing !== null) {
          const ended = maximum(yes.terminated, no.terminated), resumed = maximum(yes.continuing, no.continuing);
          terminated = maximum(terminated, ended === null ? null : continuing + ended);
          continuing = resumed === null ? null : continuing + resumed;
        }
      } else throw new Error("Calendar composition supports decisions and Returns, not branch merges or collections");
    }
    return { continuing, terminated };
  };
  const bounds = visit(root, new Set(), true);
  return { predecessors, unreachable: [...unreachable], hasCondition, maxEffects: maximum(bounds.continuing, bounds.terminated) ?? 0 };
}

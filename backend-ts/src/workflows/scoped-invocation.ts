import { parseReadControlFlow, type ReadControlNode, type ReadSequence } from "./read-control-flow.js";
import type { ReadIteration } from "./read-interpreter.js";

type LoopOwner = { loopId: string; maxItems: number };
type BodyOwner = { protectedId: string; loopDepth: number };
type Descriptor = { id: string; kind: ReadControlNode["kind"]; loops: LoopOwner[]; bodies: BodyOwner[]; actionIndex?: number };
export type ScopedInvocation = {
  profile: "scoped-invocation/v1";
  nodeId: string;
  kind: ReadControlNode["kind"];
  invocationId: string;
  iterations: ReadIteration[];
  actionIndex?: number;
  /** Nearest body first; a handler is outside its own protected body. These
   * are structural candidates, never proof of an eligible failure/selection. */
  protectedBodies: Array<{ protectedId: string; invocationId: string }>;
};
const invocationId = (id: string, iterations: readonly ReadIteration[]) =>
  [...iterations.flatMap(frame => [frame.loopId, String(frame.index)]), id].join("/");

/** Exact static invocation ownership shared by test-data and future durable
 * collection journals. No worker, receipt, admission, provider or dispatch
 * authority is created. Historical v8 operation identities are unchanged. */
export class ScopedInvocationIndex {
  readonly #nodes = new Map<string, Descriptor>();
  readonly #collectionBounds = new Map<string, number>();
  constructor(root: ReadSequence) {
    const parsed = parseReadControlFlow({ schemaVersion: "read-control-flow/v4", root });
    let actionIndex = 0;
    const visit = (block: ReadSequence, loops: LoopOwner[], bodies: BodyOwner[]) => {
      if (loops.length > 8) throw new Error("Invocation scope exceeds supported iteration depth");
      for (const node of block.nodes) {
        const id = node.kind === "action" ? node.nodeId : node.id;
        if (this.#nodes.has(id)) throw new Error("Invocation node has duplicate structural ownership");
        this.#nodes.set(id, { id, kind: node.kind, loops, bodies, ...(node.kind === "action" ? { actionIndex: actionIndex++ } : {}) });
        if (node.kind === "if") { visit(node.then, loops, bodies); visit(node.else, loops, bodies); }
        else if (node.kind === "foreach") {
          this.#collectionBounds.set(id, node.maxItems);
          visit(node.body, [...loops, { loopId: id, maxItems: node.maxItems }], bodies);
        }
        else if (node.kind === "protect") {
          visit(node.body, loops, [...bodies, { protectedId: id, loopDepth: loops.length }]);
          visit(node.handler, loops, bodies);
        }
      }
    };
    visit(parsed.root, [], []);
  }
  resolve(nodeId: string, iterations: readonly ReadIteration[], collectionItem = false): ScopedInvocation {
    const node = this.#nodes.get(nodeId);
    if (!node || !Array.isArray(iterations) || iterations.length > 8 || typeof collectionItem !== "boolean")
      throw new Error("Invocation has no exact declared node and iteration scope");
    let loops = node.loops;
    if (collectionItem) {
      if (node.kind !== "foreach") throw new Error("Only a collection has an item boundary");
      // The collection declaration is not itself inside its iteration, but
      // each item receipt is. The exact declaration supplies the item bound.
      const ownedLoop = this.#collectionBounds.get(nodeId);
      loops = [...loops, { loopId: nodeId, maxItems: ownedLoop! }];
    }
    if (iterations.length !== loops.length || loops.some((owner, index) => {
      const frame = iterations[index];
      return !frame || Object.keys(frame).sort().join("|") !== "index|loopId" || frame.loopId !== owner.loopId ||
        !Number.isSafeInteger(frame.index) || frame.index < 0 || frame.index >= owner.maxItems;
    })) throw new Error("Invocation must match exact declared iteration scope, ownership and bounds");
    const frames = iterations.map(frame => ({ ...frame }));
    return { profile: "scoped-invocation/v1", nodeId, kind: node.kind, invocationId: invocationId(nodeId, frames), iterations: frames,
      ...(node.actionIndex === undefined ? {} : { actionIndex: node.actionIndex }),
      protectedBodies: [...node.bodies].reverse().map(owner => ({ protectedId: owner.protectedId,
        invocationId: invocationId(owner.protectedId, frames.slice(0, owner.loopDepth)) })) };
  }
  resolveAddress(address: string, collectionItem = false): ScopedInvocation {
    if (typeof address !== "string" || address.length > 1100) throw new Error("Invocation address exceeds supported bounds");
    const parts = address.split("/");
    if (parts.length > 17 || parts.length % 2 !== 1 || parts.some((part, index) => index % 2 === 1 && !/^(0|[1-9][0-9]?)$/.test(part)))
      throw new Error("Invocation address is not canonical");
    const iterations = Array.from({ length: (parts.length - 1) / 2 }, (_, index) => ({ loopId: parts[index * 2]!, index: Number(parts[index * 2 + 1]) }));
    const identity = this.resolve(parts.at(-1)!, iterations, collectionItem);
    if (identity.invocationId !== address) throw new Error("Invocation address differs from its exact scope");
    return identity;
  }
}

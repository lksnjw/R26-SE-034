import { createHash } from "node:crypto";
import { canonicalJSONBytes } from "../core/canonical-json.js";

type Node = { key: string; priority: string; valueHash: string; left: Node | null; right: Node | null; fingerprint: string; size: number };
const digest = (value: unknown) => createHash("sha256").update(canonicalJSONBytes(value)).digest("hex");
const empty = digest(["runtime-record-index/v1", "empty"]);
const node = (key: string, priority: string, valueHash: string, left: Node | null, right: Node | null): Node => ({ key, priority, valueHash, left, right,
  size: 1 + (left?.size ?? 0) + (right?.size ?? 0), fingerprint: digest(["runtime-record-index/v1", key, valueHash, left?.fingerprint ?? empty, right?.fingerprint ?? empty]) });
const higher = (left: Node, right: Node) => left.priority < right.priority || left.priority === right.priority && left.key < right.key;
const depthGuard = (depth: number) => { if (depth > 128) throw new Error("Normalized record index exceeds its bounded depth"); };
function insert(root: Node | null, key: string, valueHash: string, depth = 0): Node {
  depthGuard(depth);
  if (!root) return node(key, digest(["runtime-record-priority/v1", key]), valueHash, null, null);
  if (root.key === key) return node(key, root.priority, valueHash, root.left, root.right);
  if (key < root.key) {
    const left = insert(root.left, key, valueHash, depth + 1), result = node(root.key, root.priority, root.valueHash, left, root.right);
    return higher(left, result) ? node(left.key, left.priority, left.valueHash, left.left, node(result.key, result.priority, result.valueHash, left.right, result.right)) : result;
  }
  const right = insert(root.right, key, valueHash, depth + 1), result = node(root.key, root.priority, root.valueHash, root.left, right);
  return higher(right, result) ? node(right.key, right.priority, right.valueHash, node(result.key, result.priority, result.valueHash, result.left, right.left), right.right) : result;
}
function merge(left: Node | null, right: Node | null, depth: number): Node | null {
  depthGuard(depth); if (!left) return right; if (!right) return left;
  return higher(left, right) ? node(left.key, left.priority, left.valueHash, left.left, merge(left.right, right, depth + 1))
    : node(right.key, right.priority, right.valueHash, merge(left, right.left, depth + 1), right.right);
}
function remove(root: Node | null, key: string, depth = 0): Node | null {
  depthGuard(depth); if (!root) return null;
  if (key === root.key) return merge(root.left, root.right, depth + 1);
  return key < root.key ? node(root.key, root.priority, root.valueHash, remove(root.left, key, depth + 1), root.right)
    : node(root.key, root.priority, root.valueHash, root.left, remove(root.right, key, depth + 1));
}

/** Immutable deterministic Merkle treap. Each touched record updates a bounded
 * search path; the authenticated head binds every key/value and omission.
 * A commutative XOR checksum is deliberately not a content-integrity proof. */
export class RuntimeRecordIndex {
  constructor(private readonly root: Node | null = null) {}
  get size() { return this.root?.size ?? 0; }
  get fingerprint() { return this.root?.fingerprint ?? empty; }
  with(key: string, valueHash: string): RuntimeRecordIndex {
    if (!key.length || key.length > 16_384 || !/^[a-f0-9]{64}$/.test(valueHash)) throw new Error("Invalid normalized record index entry");
    return new RuntimeRecordIndex(insert(this.root, key, valueHash));
  }
  without(key: string): RuntimeRecordIndex { return new RuntimeRecordIndex(remove(this.root, key)); }
}

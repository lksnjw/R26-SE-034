import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { RuntimeRecordIndex } from "../src/storage/runtime-record-index.js";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
test("the Merkle root is independent of insertion order and binds every exact key/value", () => {
  const entries = Array.from({ length: 500 }, (_, index) => [`run-${index}/node`, hash(`answer-${index}`)] as const);
  const build = (values: typeof entries) => values.reduce((index, [key, value]) => index.with(key, value), new RuntimeRecordIndex());
  const first = build(entries), reverse = build([...entries].reverse()); expect(first.size).toBe(500); expect(first.fingerprint).toBe(reverse.fingerprint);
  expect(first.with(entries[0]![0], hash("forged")).fingerprint).not.toBe(first.fingerprint); expect(first.without(entries[0]![0]).fingerprint).not.toBe(first.fingerprint);
  expect(first.with("other-key", entries[0]![1]).fingerprint).not.toBe(first.fingerprint); expect(first.with(entries[0]![0], entries[0]![1]).size).toBe(500);
  expect(first.without(entries[0]![0]).with(entries[0]![0], entries[0]![1]).fingerprint).toBe(first.fingerprint);
});
test("candidate updates are immutable and deleting all keys restores the empty root", () => {
  const empty = new RuntimeRecordIndex(), first = empty.with("a", hash("A")).with("b", hash("B")); expect(empty.size).toBe(0);
  expect(first.without("a").without("b").fingerprint).toBe(empty.fingerprint); expect(first.without("not-there").fingerprint).toBe(first.fingerprint); expect(first.size).toBe(2);
});
test("replaying many old values preserves count but necessarily changes the Merkle root", () => {
  let old = new RuntimeRecordIndex(), fresh = new RuntimeRecordIndex();
  for (let index = 0; index < 300; index++) { old = old.with(String(index), hash(`old-${index}`)); fresh = fresh.with(String(index), hash(`new-${index}`)); }
  expect(old.size).toBe(fresh.size); expect(old.fingerprint).not.toBe(fresh.fingerprint);
});

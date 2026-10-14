import { expect, test } from "vitest";
import { ReadContinuationCodec, type ReadContinuationBody } from "../src/runner/read-continuation.js";
import { initialState, restoreState } from "../src/repository/store.js";

const key = "private-cursor-fixture-key-at-least-32-bytes";
const body = (): ReadContinuationBody => ({ profile: "private-read-continuation/v1", identity: "run-epoch-and-input", evidenceBinding: "exact-evidence",
  machine: { profile: "read-machine/v1", sourceHash: "source", semanticHash: "semantic", cursor: 0, visits: 0, values: { input: { token: "private-fixture-secret" } }, iterations: [], frames: [], done: false },
  completion: { profile: "read-completion/v1", collections: [], completed: [] }, used: [], hasFinal: false });

test("randomized authenticated continuation ciphertext never includes its private inputs and returns an independent value", () => {
  const codec = new ReadContinuationCodec(key), value = body(), first = codec.encode("run", value), second = codec.encode("run", value);
  expect(first.ciphertext).not.toBe(second.ciphertext); expect(JSON.stringify(first)).not.toContain("private-fixture-secret"); expect(JSON.stringify(first)).not.toContain(key);
  const decoded = codec.decode(first, "run", value.identity, value.evidenceBinding); expect(decoded).toEqual(value);
  (decoded.machine.values.input as any).token = "changed"; expect(codec.decode(first, "run", value.identity, value.evidenceBinding)).toEqual(value);
});

test.each(["key", "run", "identity", "evidence", "tamper", "truncated", "noncanonical-base64", "profile", "extra"])("changed %s continuation fails before a cursor can be restored", damage => {
  const value = body(), codec = new ReadContinuationCodec(key), record = codec.encode("run", value);
  if (damage === "tamper") { const bytes = Buffer.from(record.ciphertext, "base64"); bytes[30] = bytes[30]! ^ 1; record.ciphertext = bytes.toString("base64"); }
  if (damage === "truncated") record.ciphertext = "YQ==";
  if (damage === "noncanonical-base64") record.ciphertext += " ";
  if (damage === "profile") (record as any).profile = "other";
  if (damage === "extra") (record as any).arguments = { secret: "private" };
  expect(() => (damage === "key" ? new ReadContinuationCodec("other-server-fixture-key-at-least-32-bytes") : codec).decode(record, damage === "run" ? "other" : "run", damage === "identity" ? "changed" : value.identity, damage === "evidence" ? "changed" : value.evidenceBinding)).toThrow();
});

test.each(["duplicate-used", "extra-field", "missing-machine", "wrong-completion", "false-final", "missing-final", "used-limit"])("malformed private body %s is not an accepted checkpoint", damage => {
  const value = body(), codec = new ReadContinuationCodec(key);
  if (damage === "duplicate-used") value.used = ["one", "one"];
  if (damage === "extra-field") (value as any).authority = true;
  if (damage === "missing-machine") delete (value as any).machine;
  if (damage === "wrong-completion") (value.completion as any).profile = "other";
  if (damage === "false-final") value.observedFinal = null;
  if (damage === "missing-final") value.hasFinal = true;
  if (damage === "used-limit") value.used = Array.from({ length: 5001 }, (_v, i) => String(i));
  const record = codec.encode("run", value); expect(() => codec.decode(record, "run", value.identity, value.evidenceBinding)).toThrow();
});

test("old aggregate repositories restore an empty private map; malformed or orphan maps are not silently discarded", () => {
  const legacy = initialState(); delete (legacy as any).readContinuations;
  expect(restoreState(Buffer.from(JSON.stringify(legacy))).readContinuations).toEqual({});
  for (const record of [null, [], { run: { profile: "read-continuation/v1", executionId: "run", ciphertext: "encrypted" } }]) {
    expect(() => restoreState(Buffer.from(JSON.stringify({ ...legacy, readContinuations: record })))).toThrow();
  }
});

test("private continuation storage has explicit key and payload bounds", () => {
  expect(() => new ReadContinuationCodec("short")).toThrow(); const value = body(); value.machine.values.large = "x".repeat(4_000_000);
  expect(() => new ReadContinuationCodec(key).encode("run", value)).toThrow(/bounded storage/);
});

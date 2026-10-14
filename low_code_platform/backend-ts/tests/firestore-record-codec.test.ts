import { expect, test } from "vitest";
import { FirestoreRecordCodec, FIRESTORE_RECORD_BOUNDS as B, type FirestoreNamespace } from "../src/storage/firestore-record-codec.js";
import type { RuntimeRecord } from "../src/storage/execution-record-layout.js";

const scope = { projectId: "demo-lcwe-records", databaseId: "(default)", workspaceId: "fixture_workspace" }, key = "k".repeat(32);
const codec = new FirestoreRecordCodec(key, scope);
const record = (value: unknown): RuntimeRecord => ({ profile: "runtime-record/v1", path: ["outputs", "run/one", "__proto__"], value });
const decode = (encoded: ReturnType<typeof codec.encodeRecord>, selected = codec) => selected.decodeRecord(encoded.chunks.map(chunk => selected.decodeChunk(chunk.id, chunk.document)));

test.each([false, 0, null, "", { answer: "invoice", private: "synthetic-secret" }, JSON.parse('{"__proto__":null,"a/b":false,"constructor":0}')])("canonical JSON payload round-trips without exposing values or paths", value => {
  const source = record(value), encoded = codec.encodeRecord(source); expect(decode(encoded)).toEqual(source);
  for (const chunk of encoded.chunks) {
    expect(chunk.id).toMatch(/^[a-f0-9]{64}-\d\d$/);
    expect(chunk.document.payload.includes(Buffer.from("synthetic-secret"))).toBe(false);
    expect(chunk.document.payload.includes(Buffer.from("run/one"))).toBe(false);
  }
});
test("an incompressible-sized existing continuation fits bounded binary chunks, including Unicode boundaries", () => {
  const source = record("x".repeat(5_400_000) + "😀終"), encoded = codec.encodeRecord(source);
  expect(encoded.chunks.length).toBeGreaterThan(10); expect(decode(encoded)).toEqual(source);
  expect(encoded.chunks.every(chunk => chunk.document.payload.length + 8192 < B.documentBytes)).toBe(true);
  expect(encoded.chunks.reduce((sum, chunk) => sum + chunk.document.payload.length, 0)).toBeLessThan(encoded.bytes.length + 30_000);
});
test.each(["workspace", "project", "database", "key"])("authenticated %s substitution fails, even if ciphertext and addresses were copied", changed => {
  const namespace = { ...scope }; if (changed === "workspace") namespace.workspaceId = "other"; if (changed === "project") namespace.projectId = "demo-other-project"; if (changed === "database") namespace.databaseId = "other-database";
  const other = new FirestoreRecordCodec(changed === "key" ? "z".repeat(32) : key, namespace), encoded = codec.encodeRecord(record("private"));
  expect(() => decode(encoded, other)).toThrow();
  expect(() => other.decodeHead(codec.encodeHead({ revision: 1 }))).toThrow();
});
test.each(["ciphertext", "address", "missing", "duplicate", "mixed-record", "extra-field", "plaintext", "wrong-profile"])("damaged %s chunks fail closed", damage => {
  const encoded = codec.encodeRecord(record("x".repeat(B.chunkBytes * 2))), other = codec.encodeRecord({ ...record("different"), path: ["outputs", "other", "one"] });
  if (damage === "ciphertext") encoded.chunks[0]!.document.payload[80] = encoded.chunks[0]!.document.payload[80]! ^ 1;
  if (damage === "address") encoded.chunks[0]!.id = other.chunks[0]!.id;
  if (damage === "missing") encoded.chunks.pop();
  if (damage === "duplicate") encoded.chunks[1] = encoded.chunks[0]!;
  if (damage === "mixed-record") encoded.chunks[1] = other.chunks[0]!;
  if (damage === "extra-field") (encoded.chunks[0]!.document as any).extra = true;
  if (damage === "plaintext") encoded.chunks[0]!.document.payload = Buffer.from(JSON.stringify(record("private")));
  if (damage === "wrong-profile") encoded.chunks[0]!.document.profile = "legacy" as any;
  expect(() => decode(encoded)).toThrow();
});
test("head packets and chunk packets cannot be substituted for one another", () => {
  const chunk = codec.encodeRecord(record(true)).chunks[0]!;
  expect(() => codec.decodeHead(chunk.document)).toThrow(); expect(() => codec.decodeChunk(chunk.id, codec.encodeHead({ revision: 1 }))).toThrow();
});

test("chunk addresses are stable for the same content but change for a new logical revision", () => {
  const first = codec.encodeRecord(record("first")), repeat = codec.encodeRecord(record("first")), next = codec.encodeRecord(record("next"));
  expect(first.chunks[0]!.id).toBe(repeat.chunks[0]!.id);
  expect(first.chunks[0]!.document.payload.equals(repeat.chunks[0]!.document.payload)).toBe(false);
  expect(first.chunks[0]!.id).not.toBe(next.chunks[0]!.id);
  expect(codec.manifestId(first.key)).toBe(codec.manifestId(next.key));
  expect(() => codec.decodeChunk(first.chunks[0]!.id, next.chunks[0]!.document)).toThrow();
  expect(() => codec.manifestId(' ["outputs"]')).toThrow();
});
test.each([undefined, NaN, Infinity, 1n, () => true, new Date(), new Uint8Array([1]), [, 1], Object.assign([1], { extra: true })])("lossy/non-JSON input is rejected before encryption", value => expect(() => codec.encodeRecord(record(value))).toThrow());
test("accessors, cycles, malformed private paths, excessive depth and oversize never serialize or dispatch", () => {
  let reads = 0; const accessor = Object.defineProperty({}, "secret", { enumerable: true, get() { reads++; return "secret"; } });
  expect(() => codec.encodeRecord(record(accessor))).toThrow(); expect(reads).toBe(0);
  const cyclic: any = {}; cyclic.self = cyclic; expect(() => codec.encodeRecord(record(cyclic))).toThrow();
  let nested: unknown = true; for (let depth = 0; depth < 70; depth++) nested = { child: nested };
  expect(() => codec.encodeRecord(record(nested))).toThrow();
  expect(() => codec.encodeRecord({ ...record(true), path: [] })).toThrow();
  expect(() => codec.encodeRecord({ ...record(true), path: ["x".repeat(4097)] })).toThrow();
  expect(() => codec.encodeRecord(record("x".repeat(B.recordBytes)))).toThrow();
});
test.each([{ ...scope, workspaceId: "other/workspace" }, { ...scope, workspaceId: "__reserved__" }, { ...scope, projectId: "" }, { ...scope, databaseId: "" }, { ...scope, hidden: true }])("explicit namespace must be bounded and unambiguous", value => expect(() => new FirestoreRecordCodec(key, value as FirestoreNamespace)).toThrow());

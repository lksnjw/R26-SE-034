import { expect, test } from "vitest";
import { ProtectedContinuationCodec } from "../src/runner/protected-continuation.js";
import { ProtectedMachine, protectedMachinePlan } from "../src/workflows/protected-machine.js";
import { ReadContinuationCodec } from "../src/runner/read-continuation.js";

const key = "server-held-protected-fixture-key-at-least-32-bytes";
const compiled = protectedMachinePlan(`sha256:${"a".repeat(64)}`, { kind: "sequence", nodes: [{ kind: "action", nodeId: "lookup" }] },
  [{ id: "lookup", input: { kind: "object", fields: { id: { kind: "ref", source: "workflowInput", path: ["id"] } } } }]);
const context = { executionId: "run-a", workflowId: "flow-a", epoch: 1, actorId: "actor-a", roleId: "role-a", admittedRole: "Platform Admin", sourceHash: compiled.sourceHash, semanticHash: compiled.semanticHash };
const input = { id: "synthetic-private-value-must-not-be-plaintext" };
function fixture() {
  const codec = new ProtectedContinuationCodec(key), machine = new ProtectedMachine(compiled, input); machine.peek();
  const identity = codec.identity(context, input), receipts = { profile: "synthetic-complete-evidence/v1", records: [], lastSequence: 0 },
    evidence = codec.evidenceBinding(identity, receipts), record = codec.encode(identity, evidence, machine.snapshot());
  return { codec, machine, identity, receipts, evidence, record };
}

test("private machine is encrypted and resumes the same pending boundary under exact context/evidence", () => {
  const { codec, machine, identity, evidence, record } = fixture();
  expect(JSON.stringify(codec)).not.toContain(key); expect(Object.keys(codec)).toEqual([]);
  expect(JSON.stringify(record)).not.toContain(input.id);
  const opened = codec.decode(record, identity, evidence), restored = new ProtectedMachine(compiled, {}, opened);
  expect(restored.peek()).toEqual(machine.peek());
  restored.accept({ content: [], structuredContent: { text: "acknowledged fixture" } }); expect(restored.peek()).toBeNull();
  expect(machine.peek()).toMatchObject({ kind: "action", nodeId: "lookup" });
});

test.each(["executionId", "workflowId", "epoch", "actorId", "roleId", "admittedRole", "sourceHash", "semanticHash", "inputBinding"])("%s substitution cannot restore another continuation", field => {
  const { codec, identity, evidence, record } = fixture(), changed: any = structuredClone(identity);
  changed[field] = field === "epoch" ? 2 : field === "inputBinding" ? `hmac-sha256:${"c".repeat(64)}` : field.endsWith("Hash") ? `sha256:${"b".repeat(64)}` : `${changed[field]}-other`;
  expect(() => codec.decode(record, changed, evidence)).toThrow();
});

test("fresh current evidence binding refuses changed, missing or reordered saved facts", () => {
  const { codec, identity, record } = fixture();
  for (const changed of [{ records: [] }, { records: ["invented"] }, { lastSequence: 1 }])
    expect(() => codec.decode(record, identity, codec.evidenceBinding(identity, changed))).toThrow(/evidence/);
  expect(codec.evidenceBinding(identity, { records: ["a", "b"] })).not.toBe(codec.evidenceBinding(identity, { records: ["b", "a"] }));
});

test("encoding cannot silently relabel source, semantic plan or original private input", () => {
  const { codec, identity, evidence, machine } = fixture();
  for (const field of ["sourceHash", "semanticHash", "input"] as const) {
    const changed = machine.snapshot(); if (field === "input") changed.values.input = { id: "foreign" }; else changed[field] = `sha256:${"b".repeat(64)}`;
    expect(() => codec.encode(identity, evidence, changed)).toThrow(/changed/);
  }
});

test.each(["key", "ciphertext", "noncanonical", "plaintext", "extra", "historical-profile"])("%s damage cannot decode or cross the old read-continuation domain", damage => {
  const { codec, identity, evidence, record } = fixture(); const modified: any = structuredClone(record);
  if (damage === "key") { expect(() => new ProtectedContinuationCodec(`${key}-other`).decode(record, identity, evidence)).toThrow(); return; }
  if (damage === "ciphertext") { const bytes = Buffer.from(record.ciphertext, "base64"); bytes[30]! ^= 1; modified.ciphertext = bytes.toString("base64"); }
  if (damage === "noncanonical") modified.ciphertext += "\n";
  if (damage === "plaintext") modified.ciphertext = Buffer.from(JSON.stringify({ identity, evidence })).toString("base64");
  if (damage === "extra") modified.approval = true;
  if (damage === "historical-profile") modified.profile = "read-continuation/v1";
  expect(() => codec.decode(modified, identity, evidence)).toThrow();
  expect(() => new ReadContinuationCodec(key).decode({ ...record, profile: "read-continuation/v1" }, context.executionId, "old", "old")).toThrow();
});

test("private context requires positive epoch, bounded identities and no authority fields", () => {
  const codec = new ProtectedContinuationCodec(key);
  for (const changed of [{ ...context, epoch: 0 }, { ...context, actorId: "" }, { ...context, approval: true }])
    expect(() => codec.identity(changed as any, input)).toThrow();
  expect(() => new ProtectedContinuationCodec("short")).toThrow();
});

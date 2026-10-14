import { expect, test } from "vitest";
import { ProtectedMachine } from "../src/workflows/protected-machine.js";
import { ProtectedInvocationLedger } from "../src/runner/protected-invocation-ledger.js";
import { assertProtectedInvocationLedger, protectedJournalHash as hash, protectedInvocationOperationKey } from "../src/repository/protected-invocation-records.js";
import type { ProtectedMachinePoint } from "../src/workflows/protected-machine-state.js";
import { fixtureOutput as output } from "./fixtures/protected-simulation.js";
import { canonicalJSONBytes } from "../src/core/canonical-json.js";
import { protectedInvocationFixture as ledgerFixture, protectedInvocationFixtureFailure as privateFailure } from "./fixtures/protected-invocation.js";
const typed = (point: ProtectedMachinePoint) => ["merge", "return", "collection-item"].includes(point.kind) ||
  point.kind === "collection-complete" && point.outcome === "SUCCEEDED" || point.kind === "protected-complete" && ["SUCCEEDED", "HANDLED_ERROR"].includes(point.outcome!);
function completedLedger(handled = true, items = ["A", "B"]) {
  const f = ledgerFixture(items); let machine = f.machine, ledger = f.ledger;
  for (let count = 0; count < 100; count++) {
    const point = machine.peek(); if (!point) break;
    let result: any = { kind: "accept" };
    if (point.kind === "action") {
      const key = ledger.prepare(machine, "read", { kind: "node" }, point.arguments, 1);
      ledger.dispatchIntent(machine, key, point.arguments, 1);
      if (handled && point.invocationId === "each/0/lookup") {
        const fault = { code: "ERP_RESOURCE_NOT_FOUND" as const, failedNodeId: point.nodeId, failedInvocationId: point.invocationId }, proof = privateFailure();
        ledger.acknowledgeReadError(machine, key, fault, proof, 1);
        result = { kind: "business-read-failure", fault, intentKey: key, businessFailureHash: hash(proof) };
      } else {
        const value = output(point.invocationId === "each/0/fallback" ? "First handled" : point.invocationId.includes("each/0/") ? "First body" : "Second body");
        ledger.acknowledgeOutput(machine, key, value, 1); result.output = value;
      }
    } else if (typed(point)) result.output = { value: point.value };
    const before = machine.snapshot(), advanced = ledger.advance(machine, result);
    expect(machine.snapshot()).toEqual(before); // No ACK means no active-machine mutation.
    machine = new ProtectedMachine(f.plan, {}, advanced.machine.snapshot());
    ledger = new ProtectedInvocationLedger(f.identity, f.plan, machine, advanced.ledger);
  }
  expect(machine.peek()).toBeNull(); return { ...f, machine, ledger, saved: ledger.snapshot() };
}
function actionFixture() {
  const f = ledgerFixture(["A"]); let machine = f.machine, ledger = f.ledger;
  while (machine.peek()?.kind !== "action") {
    const point = machine.peek()!, advanced = ledger.advance(machine, { kind: "accept", ...(typed(point) ? { output: { value: point.value } } : {}) });
    machine = advanced.machine; ledger = new ProtectedInvocationLedger(f.identity, f.plan, machine, advanced.ledger);
  }
  return { ...f, machine, ledger };
}

test.each([false, true])("all boundaries restore distinct item intents/receipts, handled=%s", handled => {
  const f = completedLedger(handled);
  expect(f.machine.snapshot().result).toEqual({ value: [handled ? "First handled" : "First body", "Second body"] });
  expect(f.saved.state).toBe("FINISHED");
  const reads = Object.values(f.saved.intents).filter(item => item.boundary.nodeId === "lookup");
  expect(reads.map(item => item.boundary.invocationId)).toEqual(["each/0/lookup", "each/1/lookup"]);
  expect(reads[0]!.key).not.toBe(reads[1]!.key); expect(reads[0]!.argumentHash).not.toBe(reads[1]!.argumentHash);
  expect(Object.keys(f.saved.receipts)).toHaveLength(f.machine.snapshot().sequence);
});
test("empty loop retains skipped templates and a typed empty aggregate, not fictitious invocations", () => {
  const f = completedLedger(false, []); expect(f.saved.intents).toEqual({}); expect(f.machine.snapshot().result).toEqual({ value: [] });
  expect(Object.values(f.saved.receipts).some(row => row.boundary.scope === "unentered-template")).toBe(true);
});
test("canonical saved-object key order does not change the verified v1 machine replay", () => {
  const f = actionFixture(), before = f.machine.snapshot();
  const stored = JSON.parse(canonicalJSONBytes(before).toString("utf8"));
  expect(Object.keys(stored.values)).not.toEqual(Object.keys(before.values));
  const decoded = new ProtectedMachine(f.plan, {}, stored), ledger = new ProtectedInvocationLedger(f.identity, f.plan, decoded, f.ledger.snapshot());
  const replayed = ledger.replayedMachine().snapshot();
  expect(replayed).toEqual(before); expect(Object.keys(replayed.values)).toEqual(Object.keys(before.values));
  replayed.values.input = { items: ["forged"] }; expect(ledger.replayedMachine().snapshot()).toEqual(before);
});
test.each([0, 1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER])("never-entered transfer refuses invalid/nonadvancing epoch %s", epoch => {
  const f = actionFixture(), point = f.machine.peek()!, key = f.ledger.prepare(f.machine, "read", { kind: "node" }, point.arguments, 1), before = f.ledger.snapshot();
  expect(() => f.ledger.transferPrepared(f.machine, key, epoch)).toThrow(); expect(f.ledger.snapshot()).toEqual(before);
});
test("never-entered transfer preserves logical key and refuses entered or acknowledged calls", () => {
  const f = actionFixture(), point = f.machine.peek()!, key = f.ledger.prepare(f.machine, "read", { kind: "node" }, point.arguments, 1);
  f.ledger.transferPrepared(f.machine, key, 2); expect(f.ledger.snapshot().intents[key]).toMatchObject({ key, epoch: 2, state: "PREPARING" });
  expect(() => f.ledger.dispatchIntent(f.machine, key, point.arguments, 1)).toThrow(); f.ledger.dispatchIntent(f.machine, key, point.arguments, 2);
  expect(() => f.ledger.transferPrepared(f.machine, key, 3)).toThrow(); f.ledger.acknowledgeOutput(f.machine, key, output("real supplied DATA"), 2);
  expect(() => f.ledger.transferPrepared(f.machine, key, 3)).toThrow();
});
test("logical keys do not change with attempt nonce or worker epoch, and reject epoch/lease identity fields", () => {
  const a = actionFixture(), b = actionFixture(), point = a.machine.peek()!;
  const first = a.ledger.prepare(a.machine, "read", { kind: "node" }, point.arguments, 1), second = b.ledger.prepare(b.machine, "read", { kind: "node" }, point.arguments, 8);
  expect(first).toBe(second); expect(a.ledger.snapshot().intents[first]!.id).not.toBe(b.ledger.snapshot().intents[second]!.id);
  for (const field of ["epoch", "leaseId"])
    expect(() => protectedInvocationOperationKey({ ...a.identity, [field]: "foreign" } as any, point.invocationId, { kind: "node" })).toThrow();
});
test.each(["sourceHash", "operationHash", "machineHash", "inputHash", "executionId", "workflowId", "actorId", "roleId"])("immutable %s identity substitution cannot restore", field => {
  const f = completedLedger(), changed: any = { ...f.identity, [field]: field.endsWith("Hash") ? `sha256:${"b".repeat(64)}` : "foreign" };
  expect(() => new ProtectedInvocationLedger(changed, f.plan, f.machine, f.saved)).toThrow();
});
test.each(["prepare-again", "foreign-args", "missing-intent", "preparing-result", "wrong-epoch", "wrong-output", "duplicate-ack"])("%s cannot advance/replay an item", damage => {
  const f = actionFixture(), point = f.machine.peek()!, value = output("Body"), key = f.ledger.prepare(f.machine, "read", { kind: "node" }, point.arguments, 1);
  const before = f.machine.snapshot();
  if (damage === "prepare-again") expect(() => f.ledger.prepare(f.machine, "read", { kind: "node" }, point.arguments, 2)).toThrow(/twice/);
  if (damage === "foreign-args") expect(() => f.ledger.dispatchIntent(f.machine, key, { id: "B" }, 1)).toThrow();
  if (damage === "missing-intent") expect(() => f.ledger.dispatchIntent(f.machine, `sha256:${"b".repeat(64)}`, point.arguments, 1)).toThrow();
  if (damage === "preparing-result") expect(() => f.ledger.acknowledgeOutput(f.machine, key, value, 1)).toThrow();
  if (damage === "wrong-epoch") expect(() => f.ledger.dispatchIntent(f.machine, key, point.arguments, 2)).toThrow();
  if (["wrong-output", "duplicate-ack"].includes(damage)) {
    f.ledger.dispatchIntent(f.machine, key, point.arguments, 1); f.ledger.acknowledgeOutput(f.machine, key, value, 1);
    if (damage === "wrong-output") expect(() => f.ledger.advance(f.machine, { kind: "accept", output: output("Foreign") })).toThrow(/evidence/);
    else expect(() => f.ledger.acknowledgeOutput(f.machine, key, value, 1)).toThrow();
  }
  expect(f.machine.snapshot()).toEqual(before);
});
test.each(["missing-receipt", "missing-intent", "changed-head", "foreign-node", "wrong-args", "changed-output", "duplicate-reference", "hidden-grant", "wrong-count", "counterfeit-after"])("damaged %s private history is rejected", damage => {
  const f = completedLedger(), changed = structuredClone(f.saved), first = Object.values(changed.intents)[0]!;
  if (damage === "missing-receipt") delete changed.receipts["0"];
  if (damage === "missing-intent") delete changed.intents[first.key];
  if (damage === "changed-head") changed.head = `sha256:${"b".repeat(64)}`;
  if (damage === "foreign-node") first.boundary.nodeId = "after";
  if (damage === "wrong-args") first.argumentHash = `sha256:${"b".repeat(64)}`;
  if (damage === "changed-output") { const row = Object.values(changed.receipts).find(item => item.result.kind === "accept" && item.boundary.kind === "action")!; (row.result as any).output = output("Foreign"); }
  if (damage === "duplicate-reference") { const row = Object.values(changed.receipts).find(item => item.intentKeys.length)!; row.intentKeys.push(row.intentKeys[0]!); }
  if (damage === "hidden-grant") (first as any).approved = true;
  if (damage === "wrong-count") changed.intentCount++;
  if (damage === "counterfeit-after") changed.machineHash = `sha256:${"b".repeat(64)}`;
  expect(() => new ProtectedInvocationLedger(f.identity, f.plan, f.machine, changed)).toThrow();
});
test("unknown intent cannot be retried, acknowledged, caught or advanced, even after restore", () => {
  const f = actionFixture(), point = f.machine.peek()!, key = f.ledger.prepare(f.machine, "effect", { kind: "node" }, point.arguments, 1);
  f.ledger.dispatchIntent(f.machine, key, point.arguments, 1); f.ledger.unknown(f.machine, key, 1);
  const restored = new ProtectedInvocationLedger(f.identity, f.plan, f.machine, f.ledger.snapshot());
  expect(restored.snapshot().state).toBe("RECOVERY_REQUIRED");
  expect(() => restored.prepare(f.machine, "effect", { kind: "node" }, point.arguments, 2)).toThrow();
  expect(() => restored.acknowledgeOutput(f.machine, key, output("Late"), 1)).toThrow();
  expect(() => restored.advance(f.machine, { kind: "accept", output: output("Late") })).toThrow();
});

test.each(["arguments", "scope", "sequence"])("restored pending %s cannot substitute another item", damage => {
  const f = actionFixture(), point = f.machine.peek()!;
  const key = f.ledger.prepare(f.machine, "read", { kind: "node" }, point.arguments, 1), changed = f.ledger.snapshot(), item = changed.intents[key]!;
  if (damage === "arguments") item.argumentHash = hash({ id: "B" });
  if (damage === "scope") item.boundary.iterations = [];
  if (damage === "sequence") item.sequence++;
  expect(() => new ProtectedInvocationLedger(f.identity, f.plan, f.machine, changed)).toThrow();
});

test("acknowledged intent and receipt must retain the same complete item boundary", () => {
  const f = completedLedger(false), changed = structuredClone(f.saved), item = Object.values(changed.intents)[0]!;
  item.boundary.iterations = [];
  expect(() => assertProtectedInvocationLedger(changed, f.identity.executionId)).toThrow(/foreign/);
});
test.each(["effect", "analysis", "foreign-fault", "invalid-proof", "changed-pin"])("%s cannot manufacture a catchable private read error", damage => {
  const f = actionFixture(), point = f.machine.peek()!, purpose = damage === "effect" ? "effect" : damage === "analysis" ? "analysis" : "read";
  const key = f.ledger.prepare(f.machine, purpose, { kind: "node" }, point.arguments, 1); f.ledger.dispatchIntent(f.machine, key, point.arguments, 1);
  const fault = { code: "ERP_RESOURCE_NOT_FOUND" as const, failedNodeId: point.nodeId, failedInvocationId: damage === "foreign-fault" ? "each/1/lookup" : point.invocationId }, proof = privateFailure();
  if (damage === "invalid-proof") (proof as any).approved = true;
  if (damage === "changed-pin") proof.admissionPin.contractHash = `sha256:${"b".repeat(64)}`;
  expect(() => f.ledger.acknowledgeReadError(f.machine, key, fault, proof, 1)).toThrow();
  expect(f.ledger.snapshot().intents[key]!.state).toBe("DISPATCH_INTENT");
});
test("agent/page subkeys remain unique and all entered sub-calls must acknowledge before node completion", () => {
  const f = actionFixture(), value = output("Final"), args = { id: "A" };
  const keys = [f.ledger.prepare(f.machine, "agent-model", { kind: "agent-model", round: 0 }, args, 1),
    f.ledger.prepare(f.machine, "agent-tool", { kind: "agent-tool", round: 0, callIndex: 0 }, args, 1),
    f.ledger.prepare(f.machine, "report-page", { kind: "report-page", mode: "cursor", ordinal: 0 }, args, 1)];
  expect(new Set(keys).size).toBe(3);
  keys.forEach(key => f.ledger.dispatchIntent(f.machine, key, args, 1));
  f.ledger.acknowledgeOutput(f.machine, keys[0]!, value, 1);
  expect(() => f.ledger.advance(f.machine, { kind: "accept", output: value })).toThrow(/unacknowledged/);
  keys.slice(1).forEach(key => f.ledger.acknowledgeOutput(f.machine, key, value, 1));
  const next = f.ledger.advance(f.machine, { kind: "accept", output: value }); expect(next.receipt.intentKeys).toHaveLength(3);
  expect(() => assertProtectedInvocationLedger(next.ledger, "foreign-run")).toThrow(/identity/);
});
test("snapshot and advanced data are isolated from active state until an external acknowledged save", () => {
  const f = ledgerFixture(), before = f.ledger.snapshot(), active = f.machine.snapshot(), next = f.ledger.advance(f.machine, { kind: "accept" });
  next.ledger.identity.actorId = "foreign"; next.receipt.hash = `sha256:${"b".repeat(64)}`;
  expect(f.ledger.snapshot()).toEqual(before); expect(f.machine.snapshot()).toEqual(active);
});
test("rehashing a counterfeit but structurally consistent history cannot change authored machine semantics", () => {
  const f = completedLedger(false), changed = structuredClone(f.saved);
  const row = Object.values(changed.receipts).find(item => item.boundary.kind === "action")!;
  (row.result as any).output = output("Counterfeit");
  changed.intents[row.intentKeys[0]!]!.result!.hash = hash((row.result as any).output);
  let previous = changed.receipts["0"]!.previousHash;
  for (let at = 0; at < changed.nextSequence; at++) {
    const receipt = changed.receipts[String(at)]!; receipt.previousHash = previous;
    const { hash: _old, ...body } = receipt; receipt.hash = hash(body); previous = receipt.hash;
  }
  changed.head = previous;
  expect(() => assertProtectedInvocationLedger(changed, f.identity.executionId)).not.toThrow(); // Hashes alone are DATA, not execution truth.
  expect(() => new ProtectedInvocationLedger(f.identity, f.plan, f.machine, changed)).toThrow(/semantics/);
});

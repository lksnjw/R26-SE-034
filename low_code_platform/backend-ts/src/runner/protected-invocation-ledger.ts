import { randomUUID } from "node:crypto";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { assertBoundedFiniteJSON } from "../core/bounded-finite-json.js";
import { ProtectedMachine } from "../workflows/protected-machine.js";
import type { ProtectedMachinePoint, ProtectedMachinePlan } from "../workflows/protected-machine-state.js";
import { ScopedInvocationIndex } from "../workflows/scoped-invocation.js";
import type { ReviewedReadBusinessFailure } from "../tools/read-business-error.js";
import { assertProtectedInvocationLedger, protectedLedgerIdentitySchema, protectedDispatchComponentSchema, protectedBoundaryResultSchema,
  protectedJournalHash as hash, protectedInvocationOperationKey, protectedLedgerGenesis,
  type ProtectedLedgerIdentity, type ProtectedDispatchComponent, type ProtectedInvocationIntent, type ProtectedInvocationLedgerSnapshot,
  type ProtectedBoundaryResult, type ProtectedBoundaryReceipt } from "../repository/protected-invocation-records.js";

const same = (a: unknown, b: unknown) => canonicalJSONBytes(a).equals(canonicalJSONBytes(b));
const boundary = (point: ProtectedMachinePoint) => ({ kind: point.kind, nodeId: point.nodeId, invocationId: point.invocationId,
  iterations: point.iterations, scope: point.scope });

/** Pure private DATA journal. Preparation/dispatch/ACK methods do NOT grant
 * dispatch or prove a genuine SDK/model/approval/business result. The future
 * owned worker must persist each stage before entry/advancement and establish
 * complete compiler/provider/capability/approval/receipt authority separately. */
export class ProtectedInvocationLedger {
  readonly #identity: ProtectedLedgerIdentity;
  readonly #ownership: ScopedInvocationIndex;
  #state: ProtectedInvocationLedgerSnapshot;
  #semanticReplay: ProtectedMachine | undefined;
  constructor(identity: ProtectedLedgerIdentity, plan: ProtectedMachinePlan, machine: ProtectedMachine, saved?: ProtectedInvocationLedgerSnapshot) {
    assertBoundedFiniteJSON(identity); assertBoundedFiniteJSON(plan);
    this.#identity = protectedLedgerIdentitySchema.parse(identity); this.#ownership = new ScopedInvocationIndex(plan.flow);
    const snapshot = machine.snapshot();
    new ProtectedMachine(plan, {}, snapshot);
    if (plan.sourceHash !== identity.sourceHash || plan.semanticHash !== identity.machineHash || snapshot.sourceHash !== identity.sourceHash || snapshot.semanticHash !== identity.machineHash || hash(snapshot.values.input) !== identity.inputHash)
      throw new Error("Protected ledger differs from machine/source/original input");
    if (saved) {
      assertProtectedInvocationLedger(saved, identity.executionId);
      if (!same(saved.identity, this.#identity) || saved.machineHash !== hash(snapshot) || saved.nextSequence !== snapshot.sequence)
        throw new Error("Protected ledger differs from exact saved machine or immutable identity");
      this.#state = structuredClone(saved);
      this.#semanticReplay = this.verifySemanticHistory(plan, snapshot);
    } else {
      if (snapshot.sequence !== 0 || snapshot.status !== "RUNNING") throw new Error("Protected ledger must start before any acknowledged boundary");
      const initial = hash(snapshot);
      this.#state = { profile: "protected-invocation-ledger/v1", identity: structuredClone(this.#identity), initialMachineHash: initial, machineHash: initial,
        head: protectedLedgerGenesis(this.#identity, initial), nextSequence: 0, intentCount: 0, state: "OPEN", intents: {}, receipts: {} };
    }
    this.validateOwnership();
  }
  private verifySemanticHistory(plan: ProtectedMachinePlan, current: ReturnType<ProtectedMachine["snapshot"]>) {
    const replay = new ProtectedMachine(plan, current.values.input as Record<string, unknown>); replay.peek();
    if (hash(replay.snapshot()) !== this.#state.initialMachineHash) throw new Error("Protected ledger initial machine changed");
    for (let at = 0; at < this.#state.nextSequence; at++) {
      const point = replay.peek(), row = this.#state.receipts[String(at)]!;
      if (!point?.valid || !same(row.boundary, boundary(point)) || row.pointHash !== hash(point) || row.beforeMachineHash !== hash(replay.snapshot()))
        throw new Error("Protected receipt does not reproduce the exact authored boundary");
      for (const key of row.intentKeys) {
        const item = this.#state.intents[key]!;
        if (item.component.kind === "node" && item.argumentHash !== hash(point.arguments)) throw new Error("Protected receipt has foreign item arguments");
      }
      if (row.result.kind === "accept") replay.accept(row.result.output); else replay.fail(row.result.fault);
      replay.peek(); if (row.afterMachineHash !== hash(replay.snapshot())) throw new Error("Protected receipt after-state differs from authored semantics");
    }
    if (!same(replay.snapshot(), current)) throw new Error("Protected machine differs from complete pure receipt history");
    for (const item of Object.values(this.#state.intents).filter(item => item.sequence === this.#state.nextSequence)) {
      const point = current.pending;
      if (!point?.valid || point.kind !== "action" || !same(item.boundary, boundary(point)) ||
          item.component.kind === "node" && item.argumentHash !== hash(point.arguments))
        throw new Error("Protected pending intent differs from exact authored item boundary or arguments");
    }
    return replay;
  }
  /** Pure DATA reconstruction after complete semantic-history verification.
   * Canonical storage sorts object keys, but future scope outer-key arrays must
   * retain the original machine insertion order. Use the replayed machine,
   * never reinterpret historic v1 receipts or trust a caller's reconstructed
   * key order. No admission/SDK/handler authority is granted by this method. */
  replayedMachine(): ProtectedMachine {
    if (!this.#semanticReplay || hash(this.#semanticReplay.snapshot()) !== this.#state.machineHash)
      throw new Error("Protected ledger has no exact saved semantic replay");
    return this.#semanticReplay.fork();
  }
  private validateOwnership() {
    for (const row of [...Object.values(this.#state.intents), ...Object.values(this.#state.receipts)]) {
      const point = row.boundary;
      if (point.scope === "unentered-template") {
        if (point.kind !== "skip" || point.invocationId !== [...point.iterations.flatMap(item => [item.loopId, String(item.index)]), point.nodeId].join("/"))
          throw new Error("Protected template skip has invalid ownership");
        // Template skip can omit an unentered inner loop. A genuine machine
        // boundary must establish its selected/empty path before this record.
        continue;
      }
      const declared = this.#ownership.resolve(point.nodeId, point.iterations, point.kind === "collection-item");
      const kind = ["collection-start", "collection-item", "collection-complete"].includes(point.kind) ? "foreach" :
        ["protected-start", "protected-select", "protected-complete"].includes(point.kind) ? "protect" : ["condition", "merge"].includes(point.kind) ? "if" :
          point.kind === "skip" ? "action" : point.kind;
      if (declared.invocationId !== point.invocationId || declared.kind !== kind) throw new Error("Protected ledger node or invocation ownership changed");
    }
  }
  snapshot(): ProtectedInvocationLedgerSnapshot { assertProtectedInvocationLedger(this.#state, this.#identity.executionId); return structuredClone(this.#state); }
  private pending(machine: ProtectedMachine) {
    const snapshot = machine.snapshot(), point = snapshot.pending;
    if (this.#state.state !== "OPEN" || !point?.valid || snapshot.status !== "RUNNING" || snapshot.sequence !== this.#state.nextSequence || hash(snapshot) !== this.#state.machineHash)
      throw new Error("Protected ledger has no exact current pending machine boundary");
    return point;
  }
  /** Return stable logical key after a DATA preparation. Caller must commit it
   * under current worker authority; no broker/controller permit is returned. */
  prepare(machine: ProtectedMachine, purpose: ProtectedInvocationIntent["purpose"], component: ProtectedDispatchComponent, args: unknown, epoch: number): string {
    assertBoundedFiniteJSON(args); assertBoundedFiniteJSON(component);
    const point = this.pending(machine), sub = protectedDispatchComponentSchema.parse(component);
    if (point.kind !== "action" || point.scope !== "invocation" || !Number.isSafeInteger(epoch) || epoch < 1 || epoch >= Number.MAX_SAFE_INTEGER ||
        this.#state.intentCount >= 20000 || (["agent-model", "agent-tool", "report-page"].includes(purpose) ? sub.kind !== purpose : sub.kind !== "node"))
      throw new Error("Protected preparation requires an exact action/sub-call and bounded generation");
    if (!["read", "effect", "analysis", "agent-model", "agent-tool", "report-page"].includes(purpose)) throw new Error("Unknown protected dispatch purpose");
    // Direct calls cannot substitute arguments resolved for a different item.
    // Agent/page sub-call binding requires the separate compiled driver proof.
    if (sub.kind === "node" && !same(args, point.arguments)) throw new Error("Protected invocation arguments differ from exact pending item");
    const key = protectedInvocationOperationKey(this.#identity, point.invocationId, sub);
    if (Object.values(this.#state.intents).some(item => item.sequence === point.sequence && item.result?.kind === "READ_ERROR"))
      throw new Error("A failed read invocation cannot start dependent sub-calls");
    if (Object.hasOwn(this.#state.intents, key)) throw new Error("Protected logical invocation cannot be prepared/replayed twice");
    const next = structuredClone(this.#state);
    next.intents[key] = { profile: "protected-intent/v1", key, id: `intent-${randomUUID()}`, sequence: point.sequence,
      boundary: boundary(point), purpose, component: sub, epoch, argumentHash: hash(args), state: "PREPARING" };
    next.intentCount++;
    assertProtectedInvocationLedger(next, this.#identity.executionId); this.#state = next; return key;
  }
  dispatchIntent(machine: ProtectedMachine, key: string, args: unknown, epoch: number): void {
    assertBoundedFiniteJSON(args); const point = this.pending(machine), item = this.#state.intents[key];
    if (!item || item.state !== "PREPARING" || item.epoch !== epoch || item.sequence !== point.sequence || !same(item.boundary, boundary(point)) || item.argumentHash !== hash(args))
      throw new Error("Protected dispatch intent differs from prepared exact invocation/generation/arguments");
    item.state = "DISPATCH_INTENT";
  }
  /** Owned recovery may transfer ONLY a never-entered prepared invocation.
   * Logical key/arguments remain original; entered/unknown/ACKed calls cannot
   * become runnable through an epoch change. Caller must prove claim authority. */
  transferPrepared(machine: ProtectedMachine, key: string, epoch: number): void {
    const point = this.pending(machine), item = this.#state.intents[key];
    if (!item || item.state !== "PREPARING" || item.sequence !== point.sequence || !same(item.boundary, boundary(point)) ||
        !Number.isSafeInteger(epoch) || epoch <= item.epoch || epoch >= Number.MAX_SAFE_INTEGER) throw new Error("Only an exact never-entered preparation can transfer generation");
    item.epoch = epoch;
  }
  acknowledgeOutput(machine: ProtectedMachine, key: string, output: unknown, epoch: number): void {
    assertBoundedFiniteJSON(output); this.acknowledge(machine, key, { kind: "OUTPUT", hash: hash(output) }, epoch);
  }
  acknowledgeReadError(machine: ProtectedMachine, key: string, fault: Extract<ProtectedBoundaryResult, { kind: "business-read-failure" }>["fault"], businessFailure: ReviewedReadBusinessFailure, epoch: number): void {
    assertBoundedFiniteJSON({ fault, businessFailure }); const businessFailureHash = hash(businessFailure);
    const parsed = protectedBoundaryResultSchema.parse({ kind: "business-read-failure", fault, businessFailureHash, intentKey: key });
    if (parsed.kind !== "business-read-failure") throw new Error("Invalid protected read failure");
    const point = this.pending(machine);
    if (fault.failedNodeId !== point.nodeId || fault.failedInvocationId !== point.invocationId) throw new Error("Protected read failure belongs to another invocation");
    this.acknowledge(machine, key, { kind: "READ_ERROR", hash: hash(fault), businessFailureHash, businessFailure: structuredClone(businessFailure) }, epoch);
  }
  private acknowledge(machine: ProtectedMachine, key: string, result: NonNullable<ProtectedInvocationIntent["result"]>, epoch: number) {
    const point = this.pending(machine), item = this.#state.intents[key];
    if (!item || item.state !== "DISPATCH_INTENT" || item.epoch !== epoch || item.sequence !== point.sequence || !same(item.boundary, boundary(point)) ||
        result.kind === "READ_ERROR" && (!["read", "agent-tool", "report-page"].includes(item.purpose) || point.invocationId !== point.nodeId && !point.iterations.length))
      throw new Error("Protected acknowledgement has no exact dispatched invocation");
    const next = structuredClone(this.#state); next.intents[key]!.result = result; next.intents[key]!.state = "ACKNOWLEDGED";
    assertProtectedInvocationLedger(next, this.#identity.executionId); this.#state = next;
  }
  unknown(machine: ProtectedMachine, key: string, epoch: number): void {
    const point = this.pending(machine), item = this.#state.intents[key];
    if (!item || item.state !== "DISPATCH_INTENT" || item.sequence !== point.sequence || item.epoch !== epoch) throw new Error("Unknown outcome has no exact in-flight invocation");
    item.state = "UNKNOWN"; this.#state.state = "RECOVERY_REQUIRED";
  }
  /** Return a NEW machine and receipt DATA for one atomic owned save. The
   * supplied active machine is untouched until the caller obtains a commit ACK.
   * This is not a storage commit, handler grant, effect approval or dispatch. */
  advance(machine: ProtectedMachine, result: ProtectedBoundaryResult): { machine: ProtectedMachine; ledger: ProtectedInvocationLedgerSnapshot; receipt: ProtectedBoundaryReceipt } {
    assertBoundedFiniteJSON(result); const parsed = protectedBoundaryResultSchema.parse(result), point = this.pending(machine);
    const keys = Object.values(this.#state.intents).filter(item => item.sequence === point.sequence).map(item => item.key).sort();
    if (keys.some(key => this.#state.intents[key]!.state !== "ACKNOWLEDGED") || point.kind === "action" && !keys.length || point.kind !== "action" && keys.length)
      throw new Error("Protected boundary cannot advance with missing/unacknowledged/foreign sub-call records");
    if (point.kind === "action") {
      if (parsed.kind === "accept" && !Object.hasOwn(parsed, "output")) throw new Error("Protected action requires an acknowledged output");
      const outputHash = parsed.kind === "accept" ? hash(parsed.output) : hash(parsed.fault);
      if (parsed.kind === "accept" ? keys.some(key => this.#state.intents[key]!.result!.kind !== "OUTPUT") || !keys.some(key => this.#state.intents[key]!.result!.hash === outputHash) :
          !keys.includes(parsed.intentKey) || this.#state.intents[parsed.intentKey]!.result!.kind !== "READ_ERROR" ||
          this.#state.intents[parsed.intentKey]!.result!.hash !== outputHash ||
          (this.#state.intents[parsed.intentKey]!.result! as Extract<NonNullable<ProtectedInvocationIntent["result"]>, { kind: "READ_ERROR" }>).businessFailureHash !== parsed.businessFailureHash)
        throw new Error("Protected result does not match exact acknowledged invocation evidence");
    } else if (parsed.kind !== "accept") throw new Error("Only an action can acknowledge a business read failure");
    const nextMachine = machine.fork();
    if (parsed.kind === "accept") nextMachine.accept(parsed.output); else nextMachine.fail(parsed.fault);
    nextMachine.peek(); const after = nextMachine.snapshot(), next = structuredClone(this.#state);
    const body = { profile: "protected-boundary-receipt/v1" as const, sequence: point.sequence, boundary: boundary(point), pointHash: hash(point),
      beforeMachineHash: this.#state.machineHash, afterMachineHash: hash(after), previousHash: this.#state.head, intentKeys: keys, result: parsed };
    const receipt = { ...body, hash: hash(body) };
    next.receipts[String(point.sequence)] = receipt; next.nextSequence++; next.machineHash = body.afterMachineHash; next.head = receipt.hash;
    if (after.status !== "RUNNING") next.state = after.status === "DONE" || after.status === "FAILED" ? "FINISHED" : "RECOVERY_REQUIRED";
    assertProtectedInvocationLedger(next, this.#identity.executionId);
    return { machine: nextMachine, ledger: next, receipt: structuredClone(receipt) };
  }
}

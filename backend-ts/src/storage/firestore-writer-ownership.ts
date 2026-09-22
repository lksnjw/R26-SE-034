import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Firestore, Transaction, DocumentSnapshot } from "@google-cloud/firestore";
import { AsyncMutex } from "../repository/async-mutex.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { FirestoreRecordCodec } from "./firestore-record-codec.js";

type Sample = { wall: number; monotonic: number };
export type FirestoreWriterClock = { sample(): Sample };
type Lease = { profile: "firestore-writer-lease/v1"; ownerId: string; leaseId: string; generation: number; sequence: number;
  acquiredAt: number; issuedAt: number; expiresAt: number; duration: number; state: "HELD" | "RELEASED"; transition: string };
type Anchor = { profile: "firestore-writer-generation/v1"; ownerId: string; leaseId: string; generation: number };
export const FIRESTORE_WRITER_BOUNDS = Object.freeze({ duration: 30_000, minimumDuration: 5_000, maximumDuration: 300_000, entryMargin: 1_000, clockTolerance: 500 });
const actualClock: FirestoreWriterClock = { sample: () => ({ wall: Date.now(), monotonic: performance.now() }) };
const same = (a: unknown, b: unknown) => canonicalJSONBytes(a).equals(canonicalJSONBytes(b));
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|"));
const integer = (value: unknown, min = 0) => Number.isSafeInteger(value) && Number(value) >= min;
export type FirestoreWriterFailureReason = "UNCONFIRMED" | "CLOCK_INVALID" | "CONTROLLER_UNAVAILABLE" | "LOCAL_DEADLINE" | "SERVER_TIME_INVALID" |
  "LEASE_INVALID" | "ANCHOR_INVALID" | "ANCHOR_CHANGED" | "SERVER_TIME_REGRESSED" | "WRITER_HELD" | "OWNER_CHANGED_OR_EXPIRED" |
  "GENERATION_INVALID" | "HEAD_GENERATION_INVALID" | "LEASE_CHANGED" | "TRANSITION_DEADLINE" | "ACK_DEADLINE";
export class FirestoreOwnershipFailure extends Error {
  constructor(readonly reason: FirestoreWriterFailureReason = "UNCONFIRMED") { super("Confirmed Firestore writer ownership is unavailable, expired or changed; dispatch is fenced"); }
}
// Private shutdown signal, never proof of unknown remote ownership. A closed
// controller remains unusable; only close's exact release transaction may run.
class FirestoreWriterClosed extends FirestoreOwnershipFailure {
  constructor() { super("CONTROLLER_UNAVAILABLE"); }
}
const ownershipFailure = (error: unknown) => error instanceof FirestoreOwnershipFailure ? error : new FirestoreOwnershipFailure();

/** One trusted server controller per explicit namespace. This is a lease,
 * not automatic job recovery or authorization to replay an external effect.
 * Fixed proposals/ciphertext are prepared before retryable transactions. */
export class FirestoreWriterOwnership {
  readonly path: string;
  readonly anchorPath: string;
  readonly #ownerId = randomBytes(16).toString("hex");
  readonly #leaseId = randomBytes(16).toString("hex");
  readonly #mutex = new AsyncMutex();
  readonly #observers = new Set<() => void>();
  #lease: Lease | null = null;
  #deadline = 0;
  #origin: Sample | null = null;
  #last: Sample | null = null;
  #closed = false;
  #fenced = false;
  #failureReason: FirestoreWriterFailureReason | null = null;
  constructor(readonly db: Firestore, readonly codec: FirestoreRecordCodec, readonly duration: number = FIRESTORE_WRITER_BOUNDS.duration, readonly clock: FirestoreWriterClock = actualClock) {
    if (db.databaseId !== codec.namespace.databaseId || !integer(duration, FIRESTORE_WRITER_BOUNDS.minimumDuration) || duration > FIRESTORE_WRITER_BOUNDS.maximumDuration) throw new FirestoreOwnershipFailure();
    this.path = `workspaces/${codec.namespace.workspaceId}/lcwe_runtime/writer`;
    this.anchorPath = `workspaces/${codec.namespace.workspaceId}/lcwe_runtime/writer_generation`;
  }
  observeUnavailable(observer: () => void): () => void { this.#observers.add(observer); return () => { this.#observers.delete(observer); }; }
  get generation(): number | null { return this.#lease?.generation ?? null; }
  /** Server-side bounded category only: no lease tokens, timestamps, records,
   * credentials or raw SDK errors. This never grants or restores authority. */
  get failureReason(): FirestoreWriterFailureReason | null { return this.#failureReason; }
  private deny(error?: unknown): void {
    if (this.#fenced) return; this.#fenced = true;
    this.#failureReason = ownershipFailure(error).reason;
    for (const observer of this.#observers) { try { observer(); } catch { /* denial signals cannot grant authority */ } }
  }
  private checkedSample(): Sample {
    const current = this.clock.sample(), origin = this.#origin ?? current, last = this.#last ?? current;
    if (!integer(current.wall) || !Number.isFinite(current.monotonic) || current.monotonic < 0 || current.wall < last.wall || current.monotonic < last.monotonic ||
        Math.abs((current.wall - origin.wall) - (current.monotonic - origin.monotonic)) > FIRESTORE_WRITER_BOUNDS.clockTolerance) throw new FirestoreOwnershipFailure("CLOCK_INVALID");
    return current;
  }
  private sample(): Sample {
    const current = this.checkedSample(); this.#origin ??= { ...current }; this.#last = { ...current }; return current;
  }
  private available(): void {
    if (this.#closed) throw new FirestoreWriterClosed();
    if (this.#fenced) throw new FirestoreOwnershipFailure(this.#failureReason ?? "CONTROLLER_UNAVAILABLE");
  }
  /** Synchronous final-entry guard. Only an acknowledged lease can extend
   * this deadline; probes, pending renewal and local wall time cannot do so. */
  assertActive(): void {
    if (this.#closed) throw new FirestoreWriterClosed();
    try {
      this.available(); const now = this.sample();
      if (!this.#lease || this.#lease.state !== "HELD" || now.monotonic >= this.#deadline) throw new FirestoreOwnershipFailure("LOCAL_DEADLINE");
    } catch (error) { this.deny(error); throw ownershipFailure(error); }
  }
  private time(row: DocumentSnapshot): number {
    const value = row.readTime?.toMillis();
    if (!Number.isFinite(value) || !integer(Math.floor(value), 1)) throw new FirestoreOwnershipFailure("SERVER_TIME_INVALID"); return Math.floor(value);
  }
  private decode(document: unknown): Lease {
    const value = this.codec.decodeHead(document);
    if (!exact(value, ["profile", "ownerId", "leaseId", "generation", "sequence", "acquiredAt", "issuedAt", "expiresAt", "duration", "state", "transition"]) || value.profile !== "firestore-writer-lease/v1" ||
        typeof value.ownerId !== "string" || !/^[a-f0-9]{32}$/.test(value.ownerId) || typeof value.leaseId !== "string" || !/^[a-f0-9]{32}$/.test(value.leaseId) ||
        !integer(value.generation, 1) || !integer(value.sequence, 1) || !integer(value.acquiredAt, 1) || !integer(value.issuedAt, Number(value.acquiredAt)) || !integer(value.expiresAt, Number(value.issuedAt)) ||
        !integer(value.duration, FIRESTORE_WRITER_BOUNDS.minimumDuration) || Number(value.duration) > FIRESTORE_WRITER_BOUNDS.maximumDuration ||
        !["HELD", "RELEASED"].includes(value.state as string) || Number(value.expiresAt) - Number(value.issuedAt) !== (value.state === "HELD" ? value.duration : 0) ||
        typeof value.transition !== "string" || !/^[a-f0-9]{64}$/.test(value.transition)) throw new FirestoreOwnershipFailure("LEASE_INVALID");
    return value as Lease;
  }
  private owner(lease: Lease | null): lease is Lease {
    return Boolean(lease && this.#lease && lease.state === "HELD" && lease.ownerId === this.#ownerId && lease.leaseId === this.#leaseId && same(lease, this.#lease));
  }
  private anchor(document: unknown): Anchor {
    const value = this.codec.decodeHead(document);
    if (!exact(value, ["profile", "ownerId", "leaseId", "generation"]) || value.profile !== "firestore-writer-generation/v1" || !integer(value.generation, 1) ||
        typeof value.ownerId !== "string" || !/^[a-f0-9]{32}$/.test(value.ownerId) || typeof value.leaseId !== "string" || !/^[a-f0-9]{32}$/.test(value.leaseId)) throw new FirestoreOwnershipFailure("ANCHOR_INVALID");
    return value as Anchor;
  }
  private anchorValue(lease: Lease): Anchor { return { profile: "firestore-writer-generation/v1", ownerId: lease.ownerId, leaseId: lease.leaseId, generation: lease.generation }; }
  async acquire(): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      try { this.available(); if (this.#lease) throw new FirestoreOwnershipFailure(); await this.transition("acquire"); }
      catch (error) { this.deny(error); throw ownershipFailure(error); }
    });
  }
  async renew(): Promise<void> {
    await this.#mutex.runExclusive(async () => {
      try { this.assertActive(); await this.transition("renew"); }
      catch (error) {
        // A queued renewal may reach the mutex after close's synchronous
        // revocation. No transition was entered: this is not an unknown ACK.
        if (!(error instanceof FirestoreWriterClosed)) this.deny(error);
        throw ownershipFailure(error);
      }
    });
  }
  private async transition(kind: "acquire" | "renew" | "release"): Promise<void> {
    const start = this.sample(), reference = this.db.doc(this.path), observed = await reference.get(), serverAt = this.time(observed);
    const before = observed.exists ? this.decode(observed.data()) : null;
    const anchorRef = this.db.doc(this.anchorPath), observedAnchor = await anchorRef.get(), anchor = observedAnchor.exists ? this.anchor(observedAnchor.data()) : null;
    if (before ? !same(anchor, this.anchorValue(before)) : anchor !== null) throw new FirestoreOwnershipFailure("ANCHOR_CHANGED");
    if (before && serverAt < before.issuedAt) throw new FirestoreOwnershipFailure("SERVER_TIME_REGRESSED");
    if (kind === "acquire") {
      if (before?.state === "HELD" && serverAt < before.expiresAt) throw new FirestoreOwnershipFailure("WRITER_HELD");
    } else if (!this.owner(before) || serverAt < before.issuedAt || serverAt >= before.expiresAt) throw new FirestoreOwnershipFailure("OWNER_CHANGED_OR_EXPIRED");
    const generation = kind === "acquire" ? (before?.generation ?? 0) + 1 : before!.generation, sequence = kind === "acquire" ? 1 : before!.sequence + 1;
    if (!integer(generation, 1) || !integer(sequence, 1)) throw new FirestoreOwnershipFailure("GENERATION_INVALID");
    const proposed: Lease = { profile: "firestore-writer-lease/v1", ownerId: this.#ownerId, leaseId: this.#leaseId, generation, sequence,
      acquiredAt: kind === "acquire" ? serverAt : before!.acquiredAt, issuedAt: serverAt, expiresAt: serverAt + (kind === "release" ? 0 : this.duration),
      duration: this.duration, state: kind === "release" ? "RELEASED" : "HELD", transition: this.codec.identity("writer-transition", randomBytes(16).toString("hex")) };
    if (!integer(proposed.expiresAt, 1)) throw new FirestoreOwnershipFailure("SERVER_TIME_INVALID");
    const document = this.codec.encodeHead(proposed), anchorDocument = this.codec.encodeHead(this.anchorValue(proposed)), deadline = start.monotonic + this.duration - FIRESTORE_WRITER_BOUNDS.entryMargin;
    await this.db.runTransaction(async transaction => {
      const row = await transaction.get(reference), actual = row.exists ? this.decode(row.data()) : null, now = this.time(row);
      const anchorRow = await transaction.get(anchorRef), currentAnchor = anchorRow.exists ? this.anchor(anchorRow.data()) : null;
      if (!same(currentAnchor, anchor)) throw new FirestoreOwnershipFailure("ANCHOR_CHANGED");
      if (kind === "acquire") {
        const headRow = await transaction.get(this.db.doc(`workspaces/${this.codec.namespace.workspaceId}/lcwe_runtime/head`));
        if (headRow.exists) {
          const head = this.codec.decodeHead(headRow.data()) as Record<string, unknown>;
          if (!head || typeof head !== "object" || head.profile !== "firestore-record-head/v2" || head.writerGeneration !== null && !integer(head.writerGeneration, 1) ||
              head.writerGeneration !== null && (!before || before.generation < Number(head.writerGeneration) || generation <= Number(head.writerGeneration))) throw new FirestoreOwnershipFailure("HEAD_GENERATION_INVALID");
        }
      }
      if (now < serverAt) throw new FirestoreOwnershipFailure("SERVER_TIME_REGRESSED");
      if (!same(actual, before)) throw new FirestoreOwnershipFailure("LEASE_CHANGED");
      if (kind !== "release" && (now >= proposed.expiresAt - FIRESTORE_WRITER_BOUNDS.entryMargin || this.checkedSample().monotonic >= deadline)) throw new FirestoreOwnershipFailure("TRANSITION_DEADLINE");
      if (kind !== "acquire" && now >= before!.expiresAt) throw new FirestoreOwnershipFailure("OWNER_CHANGED_OR_EXPIRED");
      if (kind === "acquire" && actual?.state === "HELD" && now < actual.expiresAt) throw new FirestoreOwnershipFailure("WRITER_HELD");
      // Shutdown denies all new dispatch synchronously, but drains an already
      // entered renewal. Aborting that known-owner transition solely because
      // close began would strand the last lease and prevent clean handoff.
      // Acquisition must still never publish authority after cancellation.
      if (kind === "acquire" && this.#closed) throw new FirestoreOwnershipFailure("CONTROLLER_UNAVAILABLE");
      transaction.set(reference, document);
      if (kind === "acquire") transaction.set(anchorRef, anchorDocument);
    }, { maxAttempts: 5 });
    if (kind === "release") { this.#lease = null; this.#deadline = 0; return; }
    if (this.#fenced || kind === "acquire" && this.#closed) throw new FirestoreOwnershipFailure(this.#failureReason ?? "CONTROLLER_UNAVAILABLE");
    const acknowledgedAt = this.sample();
    if (acknowledgedAt.monotonic >= deadline) throw new FirestoreOwnershipFailure("ACK_DEADLINE");
    // A closed controller records the exact ACK solely so close can release
    // it under the mutex. assertActive continues to reject while closed.
    this.#lease = proposed; this.#deadline = deadline;
  }
  /** Record activation and the ownership check use the same transaction.
   * All callbacks read before writing and never renew/acquire implicitly. */
  async assertTransaction(transaction: Transaction): Promise<void> {
    try {
      this.available();
      const row = await transaction.get(this.db.doc(this.path)), lease = row.exists ? this.decode(row.data()) : null, now = this.time(row);
      if (!this.owner(lease) || now < lease.issuedAt || now >= lease.expiresAt) throw new FirestoreOwnershipFailure();
      const anchor = await transaction.get(this.db.doc(this.anchorPath));
      if (!anchor.exists || !same(this.anchor(anchor.data()), this.anchorValue(lease))) throw new FirestoreOwnershipFailure();
      const local = this.checkedSample();
      if (local.monotonic >= this.#deadline || this.#fenced) throw new FirestoreOwnershipFailure();
      // Close may begin during either awaited read. The exact remote owner,
      // anchor and clock checks above still win over a shutdown-only denial.
      if (this.#closed) throw new FirestoreWriterClosed();
    } catch (error) { if (error instanceof FirestoreWriterClosed) throw error; throw new FirestoreOwnershipFailure(); }
  }
  /** Pure recheck after awaited body reads, immediately before metadata writes.
   * Denial observers run outside retryable callbacks, not in this method. */
  assertTransactionDeadline(): void {
    this.available(); const current = this.checkedSample();
    if (!this.#lease || current.monotonic >= this.#deadline) throw new FirestoreOwnershipFailure();
  }
  async withAuthority<T>(operation: () => Promise<T>): Promise<T> {
    return this.#mutex.runExclusive(async () => {
      this.assertActive();
      let result: T;
      try { result = await operation(); }
      catch (error) { if (error instanceof FirestoreOwnershipFailure && !(error instanceof FirestoreWriterClosed)) this.deny(error); throw error; }
      // The final guard already latches genuine deadline/clock denial. Normal
      // close must reject delivery without reclassifying an acknowledged
      // operation as unknown ownership and preventing exact lease release.
      this.assertActive(); return result;
    });
  }
  async close(): Promise<void> {
    if (this.#closed) return; this.#closed = true;
    // Synchronous revocation happens before waiting for any in-flight I/O.
    for (const observer of this.#observers) { try { observer(); } catch { /* denied */ } }
    await this.#mutex.runExclusive(async () => {
      try { if (this.#lease && !this.#fenced) await this.transition("release"); }
      catch (error) { this.deny(error); /* Unconfirmed/expired leases expire; never overwrite a successor. */ }
    });
  }
}

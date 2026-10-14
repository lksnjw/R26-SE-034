import type { AppConfig } from "../config/config.js";
import { boundedOperation } from "../core/bounded-operation.js";
import type { RepositoryState } from "../repository/store.js";
import { FirestoreRecordStore } from "./firestore-record-store.js";
import { assembleFirestoreState } from "./firestore-record-layout.js";
import { checkedFirestoreState } from "./firestore-records.js";
import type { ChatOperation } from "../repository/store.js";
import { FirestoreChatCancellation } from "./firestore-chat-cancellation.js";

/** This interface deliberately has no mutation, writer, checkpoint, dispatch,
 * recovery or Repository authority marker. One snapshot contains both current
 * account permissions and progress, from the same committed head transaction. */
export interface ProgressSnapshotReader {
  snapshot(options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<RepositoryState>;
  close(): Promise<void>;
  cancellationRequested?(operation: ChatOperation, signal?: AbortSignal): Promise<boolean>;
}

export function openFirestoreProgressReader(config: AppConfig): ProgressSnapshotReader {
  if (config.storageDriver !== "firestore-records") throw new Error("Progress snapshots require normalized Firestore");
  const records = FirestoreRecordStore.create(config.storageEncryptionKey, {
    projectId: config.firestoreProjectId!, databaseId: config.firestoreDatabaseId!, workspaceId: config.firestoreWorkspaceId!,
  }, { ...(config.firestoreKeyFile ? { keyFilename: config.firestoreKeyFile } : {}), ...(config.firestoreKeyJson ? { credentials: config.firestoreKeyJson } : {}) });
  const cancellation = new FirestoreChatCancellation(records, config);
  let closed = false, closing: Promise<void> | undefined;
  const assertOpen = () => { if (closed) throw new Error("Progress reader is closed"); };
  const close = () => {
    closed = true;
    return closing ??= (async () => { try { await cancellation.close(); } finally { await records.close(); } })();
  };
  return Object.freeze({
    cancellationRequested(operation: ChatOperation, signal?: AbortSignal) { assertOpen(); return cancellation.requested(operation, signal); },
    snapshot(options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
      assertOpen();
      const timeoutMs = options.timeoutMs ?? 30_000;
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Invalid progress snapshot deadline");
      return boundedOperation(async () => {
        assertOpen();
        const image = await records.load();
        assertOpen();
        const body = records.readRecords(image);
        // Missing/legacy state is never permission to seed defaults or admin.
        if (!body.length) throw new Error("No committed normalized progress image");
        const state = checkedFirestoreState(Buffer.from(JSON.stringify(assembleFirestoreState(body))));
        assertOpen(); return state;
      }, { timeoutMs, label: "Firestore progress snapshot", signal: options.signal,
        onAbandon: () => { void close().catch(() => {}); }, onLateSettlement: () => { void close().catch(() => {}); } });
    },
    close,
  });
}

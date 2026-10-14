import { createHmac, randomBytes } from "node:crypto";
import type { HandlerServices } from "../http/handlers/common.js";
import type { Repository } from "../repository/store.js";
import { decodeEncryptionKey } from "../storage/aes-gcm.js";

const memoryKeys = new WeakMap<Repository, Buffer>();
/** Normal collection execution requires the reviewed SDK boundary and either
 * explicit non-durable memory mode or actual encrypted record transactions.
 * An environment setting alone cannot qualify a storage implementation. */
export function supportsCollectionReads(services: HandlerServices): boolean {
  const runtime = services.mcpConnectionRuntime;
  const sessions = runtime ? runtime.connectionCatalog().map(item => runtime.sessionFor(item.id)).filter(value => value !== undefined) : [services.erpbridgeSession].filter(value => value !== undefined);
  const persistence = services.repository.persistence;
  if (!sessions.some(session => session.available !== false && session.requiresReviewedRevision === true && session.dispatchBoundary === "sdk-entry/v1" && !!session.admissionBinding)) return false;
  if (persistence === null) return true;
  if (persistence.readQueueDurability !== "encrypted-single-writer" || persistence.executionCheckpointDurability !== "encrypted-record-transactions/v1" || !persistence.saveExecutionCheckpoint) return false;
  try { decodeEncryptionKey(services.config.storageEncryptionKey); return true; } catch { return false; }
}

/** Stable server-only input/evidence key. Never returned in readiness, an
 * execution record, a model prompt, or a browser-supplied continuation. */
export function readIterationBindingKey(services: HandlerServices): string {
  let key: Buffer;
  if (services.repository.persistence === null) {
    key = memoryKeys.get(services.repository) ?? randomBytes(32); memoryKeys.set(services.repository, key);
  } else key = decodeEncryptionKey(services.config.storageEncryptionKey);
  return createHmac("sha256", key).update("read-iteration-binding/v1").digest("hex");
}

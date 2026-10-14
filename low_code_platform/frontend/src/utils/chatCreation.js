import { readWorkspaceValue, writeWorkspaceValue } from "./workspaceSession";

export function prepareChatCreation(storageKey, title, requestId = "") {
  let saved;
  try { saved = JSON.parse(readWorkspaceValue(storageKey, "null")); } catch { /* Ignore invalid local preferences. */ }
  if (saved && typeof saved.idempotencyKey === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(saved.idempotencyKey) && typeof saved.title === "string" && (!requestId || saved.idempotencyKey === requestId)) return saved;
  const request = { idempotencyKey: /^[A-Za-z0-9_-]{16,128}$/.test(requestId) ? requestId : crypto.randomUUID(), title };
  writeWorkspaceValue(storageKey, JSON.stringify(request));
  return request;
}

export function acknowledgeChatCreation(storageKey, request) {
  if (readWorkspaceValue(storageKey) === JSON.stringify(request)) writeWorkspaceValue(storageKey, "");
}

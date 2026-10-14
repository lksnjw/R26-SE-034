import { readWorkspaceValue, writeWorkspaceValue, workspaceKey } from "./workspaceSession";
import { staleAuthorityError } from "./authAuthority";

const pending = new Map();
// Keep only an identity and digest, not message text, provider keys or ERP arguments.
export async function prepareChatCommand(user, sessionId, content, options, isCurrent = () => true) {
  if (!isCurrent()) throw staleAuthorityError();
  const storageKey = workspaceKey(user, `chat-command.${sessionId}`);
  if (!storageKey || !globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) throw new Error("Secure request identity is unavailable. Reload in a secure browser context.");
  const bytes = new TextEncoder().encode(JSON.stringify([content, options]));
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  if (!isCurrent()) throw staleAuthorityError();
  let saved = pending.get(storageKey);
  if (!saved) { try { saved = JSON.parse(readWorkspaceValue(storageKey, "null")); } catch { /* Invalid local identity is not reused. */ } }
  if (saved?.fingerprint !== fingerprint || !/^[a-f0-9]{48}$/.test(saved?.key ?? "")) {
    saved = { fingerprint, key: Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => byte.toString(16).padStart(2, "0")).join("") };
  }
  if (!isCurrent()) throw staleAuthorityError();
  pending.set(storageKey, saved); writeWorkspaceValue(storageKey, JSON.stringify(saved));
  return { storageKey, ...saved };
}

export function acknowledgeChatCommand(command) {
  if (pending.get(command.storageKey)?.key === command.key) {
    pending.delete(command.storageKey); writeWorkspaceValue(command.storageKey, "");
  }
}

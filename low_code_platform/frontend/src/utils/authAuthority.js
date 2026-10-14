let authorityEpoch = 0;
let currentAuthority = null;

export function authorityFingerprint(user) {
  if (!user?.id) return "";
  const permissions = [...new Set(Array.isArray(user.permissions) ? user.permissions.filter(value => typeof value === "string") : [])].sort();
  return JSON.stringify([String(user.id), String(user.role || ""), permissions]);
}

export function transitionAuthority(user) {
  const next = authorityFingerprint(user);
  const changed = next !== currentAuthority;
  if (changed) {
    currentAuthority = next;
    authorityEpoch += 1;
  }
  return { epoch: authorityEpoch, fingerprint: currentAuthority, scope: authorityScopeFor(currentAuthority, authorityEpoch), changed };
}

export function beginAuthorityTransition() {
  authorityEpoch += 1;
  currentAuthority = "";
  return { epoch: authorityEpoch, fingerprint: "", scope: "" };
}

export function captureAuthority(user) {
  const expected = authorityFingerprint(user);
  return { epoch: authorityEpoch, fingerprint: expected, scope: authorityScopeFor(expected, authorityEpoch) };
}

export function isAuthorityCurrent(capture) {
  return Boolean(capture) && capture.epoch === authorityEpoch && capture.fingerprint === currentAuthority;
}

export function authorityScope(user) {
  const fingerprint = authorityFingerprint(user);
  return fingerprint ? authorityScopeFor(fingerprint, authorityEpoch) : "";
}

function authorityScopeFor(fingerprint, epoch) {
  return fingerprint ? JSON.stringify([epoch, fingerprint]) : "";
}

export function staleAuthorityError() {
  const error = new Error("Authentication changed while the request was in progress");
  error.code = "ERR_STALE_AUTHORITY";
  return error;
}

export function currentAuthorityEpoch() {
  return authorityEpoch;
}

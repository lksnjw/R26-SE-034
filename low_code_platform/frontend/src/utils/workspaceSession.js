export function workspaceKey(user, suffix) {
  const account = user?.id || user?.email;
  return account ? `workflow.workspace.${encodeURIComponent(account)}.${suffix}` : null;
}

export function readWorkspaceValue(key, fallback = "") {
  try { return key ? sessionStorage.getItem(key) ?? fallback : fallback; } catch { return fallback; }
}

export function writeWorkspaceValue(key, value) {
  try { if (key) sessionStorage.setItem(key, value); } catch { /* Storage may be disabled. */ }
}

export function workspaceReturnPath(user) {
  const path = readWorkspaceValue(workspaceKey(user, "return"), "/");
  return path === "/" || /^\/chat(?:\/[^/?#]+)?(?:\?[^#]*)?$/.test(path) ? path : "/";
}

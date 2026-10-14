// Restore the complete internal deep link after sign-in, never an external URL.
export function authenticatedReturnTarget(from) {
  if (typeof from?.pathname !== "string" || !from.pathname.startsWith("/") || from.pathname.startsWith("//") || from.pathname.includes("\\") || [...from.pathname].some(character => character.charCodeAt(0) <= 32)) return "/";
  return { pathname: from.pathname, search: typeof from.search === "string" && from.search.startsWith("?") ? from.search : "", hash: typeof from.hash === "string" && from.hash.startsWith("#") ? from.hash : "" };
}

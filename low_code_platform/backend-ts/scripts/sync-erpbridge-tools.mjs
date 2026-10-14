/** Deprecated command name retained as a READ-ONLY compatibility verifier.
 * Discovery never implies admission. Do not infer roles, risk or read-only
 * status from a remote tool name, and never append it to the trusted registry.
 * Usage: node --import tsx/esm --env-file=.env scripts/sync-erpbridge-tools.mjs
 * Preferred: npm run verify:erpbridge-registry (with configured environment).
 */
console.info("Automatic tool import is disabled. Checking the reviewed registry without modifying files or invoking tools.");
await import("./verify-erpbridge-registry.mjs");

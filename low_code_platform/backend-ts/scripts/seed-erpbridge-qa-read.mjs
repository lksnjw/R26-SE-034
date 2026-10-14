// Explicit registration of ONE synthetic read on the exact isolated MockERP
// stack. Never local capability admission, ERP writes, email or production.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertQaBridgeContainer, qaBaseURL, qaProject } from "./erpbridge-docker-qa.mjs";

export function qaReadTool() {
  return { apiVersion: "erpbridge.io/v1", kind: "MCPTool", metadata: { name: "qa_list_departments", version: "1.0.0", module: "local_qa" }, spec: {
    description: { short: "LOCAL MockERP Department list only; never production ERP or email", whenToUse: ["Isolated local read qualification"], whenNotToUse: ["Business execution or production qualification"], examples: [] },
    annotations: { title: "Local Department read", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { type: "object", properties: {}, required: [] },
    outputSchema: { type: "object", properties: { data: { type: "array", items: { type: "object" } } }, required: ["data"] },
    execution: { type: "http", method: "GET", endpoint: "/api/resource/Department" },
    security: { authType: "api-key", authHeader: "Authorization", credentialRef: "ERP_PRIMARY_KEY", credentialSource: "env", dataClass: "public", allowedRoles: [] },
  } };
}

export async function main(args) {
  if (args.length !== 1 || args[0] !== "--apply") throw new Error("Use --apply to register the one explicitly defined synthetic read tool in the isolated QA stack");
  const { stdout } = await promisify(execFile)("docker", ["inspect", `${qaProject}-erpbridge-server-1`], { timeout: 15_000, maxBuffer: 1_000_000, windowsHide: true });
  const containers = JSON.parse(stdout);
  if (containers.length !== 1) throw new Error("Expected one QA bridge");
  const token = assertQaBridgeContainer(containers[0]);
  const response = await fetch(`${qaBaseURL}/apis/erpbridge.io/v1/tools`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(qaReadTool()) });
  if (!response.ok) throw new Error(`QA tool registration failed (HTTP ${response.status}); no response body or credentials exposed`);
  await response.body?.cancel();
  console.log("Registered qa_list_departments 1.0.0 on localhost MockERP only. No ERP call; local application trust unchanged.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); }
  catch { console.error("Synthetic QA read registration was not confirmed; inspect the exact isolated stack locally. No business execution claimed."); process.exitCode = 1; }
}

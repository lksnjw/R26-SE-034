import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const base = "http://127.0.0.1:18082/api";
export async function login(email) {
  const response = await fetch(`${base}/auth/login`, {method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({email, password: "Pipeline-QA-2026!"})});
  if (!response.ok) throw new Error(`QA login failed: HTTP ${response.status}`);
  return (await response.json()).data;
}
export async function request(path, token, body) {
  const response = await fetch(`${base}${path}`, {method: body === undefined ? "GET" : "POST",
    headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(180000)});
  const value = await response.json();
  if (!response.ok) throw new Error(`QA API ${path} failed: HTTP ${response.status} ${value.message ?? ""}`);
  return value.data;
}
const account = await login("pipeline.qa@example.test");
const chats = await request("/chat/sessions", account.accessToken);
const evidence = [];
for (const chat of chats) {
  const data = await request(`/chat/sessions/${chat.id}`, account.accessToken);
  for (const message of data.messages ?? []) {
    if (message.role !== "assistant") continue;
    evidence.push({sessionId: chat.id, text: message.text, artifacts: message.artifacts});
  }
}
console.log(JSON.stringify(process.argv.includes("--full") ? evidence : evidence.map(item => ({sessionId: item.sessionId,
  text: item.text, readOutcome: item.artifacts?.readOutcome, narrativeRejected: item.artifacts?.narrativeRejected,
  tools: item.artifacts?.toolSteps?.map(step => ({name: step.toolName, status: step.status,
    dispatch: step.result?._meta?.["io.workflow-engine/dispatch"]}))})), null, 2));
await writeFile("../tmp/pipeline-local/chat-evidence.json", JSON.stringify(evidence, null, 2));
if (process.argv[2] === "--live-db") {
  const environment = JSON.parse(await readFile("../tmp/pipeline-local/session.json", "utf8"));
  const result = await promisify(execFile)("docker", ["run", "--rm", "--network", "lcwe-pipeline-local_default",
    "-e", "AI_DB_HOST=postgres", "-e", "AI_DB_NAME=erp_ai_native_db", "-e", "AI_DB_USER=erp_pipeline",
    "-e", "AI_DB_PASSWORD", "-v", `${process.cwd()}/../DATA_TRANSFORM/erp-data-transformation-pipeline:/workspace`,
    "-w", "/workspace", "lcwe-pipeline-local-erp-data-transformation-pipeline:latest", "pytest", "-q",
    "tests/erp_pipeline/storage/test_live_postgres_state.py"], {
      env: {...process.env, AI_DB_PASSWORD: environment.PIPELINE_DB_PASSWORD}, maxBuffer: 2000000, windowsHide: true});
  console.log(result.stdout);
}

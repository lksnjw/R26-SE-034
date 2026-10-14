// Actual model-backed, reader-role chat acceptance. Never supplies the expected
// reference/verification phrase to the model; these must come from stored OCR.
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile, writeFile} from "node:fs/promises";
const base = "http://127.0.0.1:18082/api";
const login = await fetch(`${base}/auth/login`, {method: "POST", headers: {"Content-Type": "application/json"},
  body: JSON.stringify({email: "reader.qa@example.test", password: "Pipeline-QA-2026!"})});
assert(login.ok, `Reader login HTTP ${login.status}`);
const token = (await login.json()).data.accessToken;
async function request(path, body) {
  const response = await fetch(`${base}${path}`, {method: body === undefined ? "GET" : "POST",
    headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(180000)});
  const value = await response.json();
  assert(response.ok, `QA chat operation HTTP ${response.status}`);
  return value.data;
}
const chat = await request("/chat/sessions", {title: "Reader: stored certificate name lookup", idempotencyKey: `pipeline-reader-${randomUUID()}`});
const result = await request(`/chat/sessions/${chat.id}/messages`, {
  content: "Find the stored image certificate for Lakshan QA Sample in source system qa_hr, entity employees. Retrieve it through the indexed ERPBridge tools and return the employee ID, certificate reference, issue date and verification phrase from the document. This is synthetic local QA."});
const message = result.assistantMessage;
const evidence = {qualifiedAt: new Date().toISOString(), sessionId: chat.id, role: "Client", text: message?.text,
  artifacts: message?.artifacts, modelBinding: message?.modelBinding, usage: result.usage};
await writeFile("../tmp/pipeline-local/reader-chat-evidence.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({sessionId: evidence.sessionId, role: evidence.role, text: evidence.text,
  readOutcome: message?.artifacts?.readOutcome, modelBinding: evidence.modelBinding,
  toolStatuses: message?.artifacts?.toolSteps?.map(step => ({name: step.toolName, status: step.status})), usage: result.usage}, null, 2));
assert.equal(message?.artifacts?.readOutcome, "READS_COMPLETED");
assert.equal(message?.artifacts?.narrativeRejected, false);
assert(message.text.includes("EMP-QA-1042"));
assert(message.text.includes("QA-7382-ORCHID"));
assert(message.text.toLowerCase().includes("silver orchid bridge"));
assert(message.artifacts.toolSteps.some(step => step.status === "SUCCEEDED" && step.result?._meta?.["io.workflow-engine/dispatch"]?.remoteName?.endsWith(".rev_MS4wLjA")));
const bridgeEvidence = JSON.parse(await readFile("../tmp/pipeline-local/retrieval-evidence.json", "utf8"));
bridgeEvidence.realModelChat = "reader role: confirmed model-backed name lookup through reviewed ERPBridge revision";
bridgeEvidence.readerChatSessionId = chat.id;
await writeFile("../tmp/pipeline-local/retrieval-evidence.json", JSON.stringify(bridgeEvidence, null, 2));
console.log("Reader role chat retrieval passed with independently retrieved OCR facts.");

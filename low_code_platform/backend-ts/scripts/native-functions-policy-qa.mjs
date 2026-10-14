import assert from "node:assert/strict";
import { createServer } from "node:http";
import { z } from "zod";

export const nativePolicyURL = "http://127.0.0.1:23676/governance";
export function nativeMatrixSynthesisPrompt(kind, fixtureId) {
  assert(["read", "operation"].includes(kind));
  if (kind === "read") return "Create and save a manual workflow with exactly one tool step: qa_list_departments, parameters {}. Read the eight synthetic Docker MockERP Departments. No analysis, agent, schedule, email, payment, write, condition or other action.";
  assert(z.uuid().safeParse(fixtureId).success);
  return `Create and save a manual workflow with exactly two ordered tool steps: qa_list_departments with parameters {}, then qa_native_integration_echo with parameters {value: "native-operation-qa-ack", fixtureId: "${fixtureId}"}. This echo is only a process-local Docker MockERP integration fixture and must use the exact literal parameters. No analysis, agent, schedule, email, payment, other write, condition or other action.`;
}
function synthesisKind(intent) {
  if (intent === nativeMatrixSynthesisPrompt("read")) return "read";
  const match = /fixtureId: "([a-fA-F0-9-]{36})"/.exec(intent);
  return match && z.uuid().safeParse(match[1]).success && intent === nativeMatrixSynthesisPrompt("operation", match[1]) ? "operation" : null;
}
const proposal = z.object({ requestId: z.uuid(),
  user: z.object({ id: z.literal("native_owner"), role: z.literal("Platform Admin"), department: z.null() }).strict(),
  intent: z.enum(["CreateWorkflow", "PublishWorkflow", "ReadJobWorker", "OperationJobWorker", "ReadToolBroker"]),
  proposedActions: z.array(z.enum(["qa_list_departments", "qa_native_integration_echo"])).min(1).max(2),
  caseContext: z.object({}).strict() }).strict().refine(value =>
    value.intent !== "ReadJobWorker" || value.proposedActions.every(action => action === "qa_list_departments"));
const synthesisProposal = z.object({ requestId: z.uuid(),
  user: z.object({ id: z.literal("native_owner"), role: z.literal("Platform Admin"), department: z.null() }).strict(),
  intent: z.string().min(1).max(2048),
  proposedActions: z.array(z.enum(["qa_list_departments", "qa_native_integration_echo"])).min(1).max(2),
  caseContext: z.object({ priorMessageCount: z.number().int().min(0).max(1) }).strict(),
}).strict().refine(value => {
  const kind = synthesisKind(value.intent);
  return kind !== null && JSON.stringify(value.proposedActions) === JSON.stringify(kind === "read"
    ? ["qa_list_departments"] : ["qa_list_departments", "qa_native_integration_echo"]);
});

/** Synthetic online policy only, for the exact demo emulator/MockERP namespace.
 * Normal registry validation, capability review and independent approval still
 * apply. Never load this helper in the deployable Functions artifact. */
export async function startNativePolicyFixture(config) {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:23671");
  assert.equal(process.env.GCLOUD_PROJECT, "demo-lcwe-records");
  assert(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
  assert.equal(config.LCWE_LOCAL_DOCKER_QA, "native-operation/v1");
  assert.equal(config.GOVERNANCE_URL, nativePolicyURL);
  assert.equal(config.ERPBRIDGE_BASE_URL, "http://127.0.0.1:18080");
  assert.equal(config.FIRESTORE_PROJECT_ID, "demo-lcwe-records");
  assert(/^test_[a-f0-9]{32}_native$/.test(config.FIRESTORE_WORKSPACE_ID));
  assert(typeof config.GOVERNANCE_API_KEY === "string" && config.GOVERNANCE_API_KEY.length >= 32);
  let available = true; const accepted = [], refused = [];
  const server = createServer(async (request, response) => {
    const reply = (status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (request.method !== "POST" || request.url !== "/governance") return reply(404, { error: "Fixture endpoint only" });
    if (request.headers.authorization !== `Bearer ${config.GOVERNANCE_API_KEY}`) return reply(403, { error: "Fixture authorization required" });
    if (!available) { refused.push("UNAVAILABLE"); request.resume(); return reply(503, { error: "Synthetic online policy unavailable" }); }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 64000) { request.resume(); return reply(413, { error: "Fixture request too large" }); }
        chunks.push(chunk);
      }
      const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const ordinary = proposal.safeParse(raw), checked = ordinary.success ? ordinary : synthesisProposal.safeParse(raw);
      if (!checked.success || new Set(checked.data.proposedActions).size !== checked.data.proposedActions.length) {
        refused.push("INVALID_PROPOSAL"); return reply(403, { error: "Proposal outside exact synthetic fixture scope" });
      }
      accepted.push({ intent: checked.data.intent, actions: checked.data.proposedActions,
        ...(!ordinary.success ? { kind: "SynthesisWorkflow" } : {}) });
      reply(200, { policyVersion: "LOCAL-native-operation-fixture/v1", rules: [], evidenceIds: ["LOCAL-SYNTHETIC-POLICY-NOT-PRODUCTION"] });
    } catch { if (!response.headersSent) reply(400, { error: "Invalid fixture request" }); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(23676, "127.0.0.1", resolve); });
  return { accepted, refused, setAvailable(value) { assert.equal(typeof value, "boolean"); available = value; },
    async close() { await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }); } };
}

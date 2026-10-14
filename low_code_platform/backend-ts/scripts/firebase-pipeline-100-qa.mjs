// Explicit local acceptance: actual Firebase task/Firestore emulators and
// separately deployed ERPBridge/pipeline. No SDK/model fixture or ERP writes.
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile, symlink, access } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import { parse, stringify } from "yaml";
import { Repository } from "../src/repository/store.ts";
import { FirestoreRecordPersistence } from "../src/storage/firestore-records.ts";
import { hashPassword } from "../src/authn/password.ts";
import { RegistryService } from "../src/registry/service.ts";
import { RegistryValidator } from "../src/validator/registry-validator.ts";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.ts";
import { remoteContractHash } from "../src/registry/discovered-contract.ts";
import { assertReadTaskOutbox } from "../src/runner/read-task-outbox.ts";
import { openNativeQaInspector } from "./native-functions-read-qa.mjs";

const output = resolve("../tmp/firebase-pipeline-100"), artifact = resolve(output, "functions"), assets = resolve(artifact, "assets");
const sessionPath = resolve(output, "qa-session.json"), evidencePath = resolve(output, "workflow-evidence.json");
const base = "http://127.0.0.1:23675/demo-lcwe-records/asia-south1/api/api";
const mode = process.argv[2];
const expectedRecord = "EMP-QA-1042", expectedReference = "QA-7382-ORCHID", expectedPhrase = "silver orchid bridge";
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function prepare() {
  try { await access(sessionPath); throw new Error("Existing isolated Firebase session preserved; use --workflow, --chat or --inspect"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const bridge = JSON.parse(await readFile("../tmp/pipeline-local/session.json", "utf8"));
  assert(bridge.mcpToken && bridge.ERP_API_KEY);
  await mkdir(resolve(assets, "configs/runtime"), { recursive: true }); await mkdir(resolve(assets, "policy"), { recursive: true });
  await writeFile(resolve(assets, "configs/runtime/pipeline_tools.json"), "[]", { flag: "wx" });
  await writeFile(resolve(assets, "configs/runtime/pipeline_rules.json"), "[]", { flag: "wx" });
  await writeFile(resolve(assets, "configs/runtime/registry_context.md"), "Local Firebase emulator document-retrieval acceptance. Use only the exact independently reviewed pipeline contracts in the current catalog. No ERP writes or production data.\n", { flag: "wx" });
  await copyFile("policy/governance_fallback.json", resolve(assets, "policy/governance_fallback.json"));
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  await writeFile(resolve(artifact, "package.json"), JSON.stringify({ name: "lcwe-local-pipeline100", private: true, type: "module", main: "index.mjs", engines: { node: "22" }, dependencies: pkg.dependencies }, null, 2), { flag: "wx" });
  await symlink(resolve("node_modules"), resolve(artifact, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  await build({ absWorkingDir: process.cwd(), entryPoints: ["src/entrypoints/firebase.ts"], outfile: resolve(artifact, "index.mjs"), bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", sourcemap: false });
  const config = { APP_ENV: "development", LCWE_LOCAL_DOCKER_QA: "native-read/v1", API_BASE_PATH: "/api", STORAGE_DRIVER: "firestore-records", FIRESTORE_PROJECT_ID: "demo-lcwe-records", FIRESTORE_DATABASE_ID: "(default)", FIRESTORE_WORKSPACE_ID: `test_${randomBytes(16).toString("hex")}_native`, STORAGE_ENCRYPTION_KEY: randomBytes(32).toString("base64"), JWT_SECRET: randomBytes(48).toString("hex"),
    MCP_MODE: "remote", MCP_TRANSPORT: "erpbridge-mcp", ERPBRIDGE_BASE_URL: "http://127.0.0.1:18080", ERPBRIDGE_MCP_TOKEN: bridge.mcpToken, ERPBRIDGE_ROLE_MAP: '{"Platform Admin":"platform_admin","Client":"client"}', MCP_TIMEOUT_MS: "60000", READ_WORKER_LEASE_MS: "240000", FUNCTIONS_WRITER_ADMISSION_TIMEOUT_MS: "30000",
    TOOL_REGISTRY_PATH: "configs/runtime/pipeline_tools.json", RULE_REGISTRY_PATH: "configs/runtime/pipeline_rules.json", PIPELINE_API_BASE_URL: "http://127.0.0.1:8000", PIPELINE_API_KEY: bridge.ERP_API_KEY, PIPELINE_TIMEOUT_MS: "180000", CORS_ORIGINS: "http://127.0.0.1:5192,http://localhost:5192" };
  await writeFile(sessionPath, JSON.stringify({ profile: "firebase-pipeline-100-qa/v1", config }), { flag: "wx", mode: 0o600 });
  await writeFile(resolve(artifact, ".secret.local"), `LCWE_RUNTIME_CONFIG=${JSON.stringify(config)}\n`, { flag: "wx", mode: 0o600 });
  await copyFile("tests/fixtures/firestore-private.rules", resolve(output, "firestore-private.rules"));
  await writeFile(resolve(output, "firebase.json"), JSON.stringify({ functions: [{ source: "functions", codebase: "pipeline100", runtime: "nodejs22" }], firestore: { rules: "firestore-private.rules" }, emulators: {
    functions: { host: "127.0.0.1", port: 23675 }, firestore: { host: "127.0.0.1", port: 23671, websocketPort: 23674 }, hub: { host: "127.0.0.1", port: 23672 }, logging: { host: "127.0.0.1", port: 23673 }, ui: { enabled: false }, singleProjectMode: true } }, null, 2), { flag: "wx" });
  console.log("Prepared separate generated Firebase artifact and fresh encrypted test namespace; existing .functions and approval workspace preserved.");
}
async function context() {
  assert.equal(process.env.FIRESTORE_EMULATOR_HOST, "127.0.0.1:23671"); assert.equal(process.env.GCLOUD_PROJECT, "demo-lcwe-records"); assert(!process.env.GOOGLE_APPLICATION_CREDENTIALS);
  const session = JSON.parse(await readFile(sessionPath, "utf8")); assert.equal(session.profile, "firebase-pipeline-100-qa/v1"); const { config } = session;
  const open = () => openNativeQaInspector(() => FirestoreRecordPersistence.open(config.STORAGE_ENCRYPTION_KEY, { projectId: config.FIRESTORE_PROJECT_ID, databaseId: config.FIRESTORE_DATABASE_ID, workspaceId: config.FIRESTORE_WORKSPACE_ID }).then(storage => Repository.open(storage)));
  let token;
  const request = async (path, payload, method = payload === undefined ? "GET" : "POST", actorToken = token) => {
    const response = await fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...(actorToken ? { Authorization: `Bearer ${actorToken}` } : {}) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), redirect: "error", signal: AbortSignal.timeout(120000) });
    const text = await response.text(); assert([config.JWT_SECRET, config.STORAGE_ENCRYPTION_KEY, config.ERPBRIDGE_MCP_TOKEN, config.PIPELINE_API_KEY].every(secret => !text.includes(secret)), "Private configuration escaped HTTP");
    const body = JSON.parse(text); return { status: response.status, body };
  };
  const data = async (path, payload, method, status = 200, actorToken) => { const response = await request(path, payload, method, actorToken); assert.equal(response.status, status, `${path}: HTTP ${response.status} ${response.body.message}`); return response.body.data; };
  const login = async (email = "firebase.pipeline@example.test") => { const auth = await data("/auth/login", { email, password: "Firebase-Pipeline-QA-2026!" }); token = auth.accessToken; return auth; };
  return { config, open, request, data, login };
}
function assertHit(result) {
  assert.equal(result.retrieval_mode, "exact"); assert.equal(result.hits.length, 1); const hit = result.hits[0];
  assert.equal(hit.record_key, expectedRecord); assert.equal(hit.source_system_id, "qa_hr"); assert.equal(hit.source_entity, "employees");
  assert(hit.text.includes(expectedReference)); assert(hit.text.toLowerCase().includes(expectedPhrase)); assert(result.text_chars_returned <= 400);
}
async function qualifyWorkflow() {
  const c = await context(), repository = await c.open(), timestamp = new Date().toISOString(), hash = await hashPassword("Firebase-Pipeline-QA-2026!");
  try { await repository.mutate(state => {
    for (const [id, email, roleId] of [["firebase_pipeline_qa", "firebase.pipeline@example.test", "role_admin"], ["firebase_pipeline_reader", "firebase.reader@example.test", "role_client"]]) {
      assert(!state.users[id] || state.users[id].email === email, "Unrelated account preserved");
      if (!state.users[id]) { state.users[id] = { id, email, name: id === "firebase_pipeline_qa" ? "Firebase Pipeline QA" : "Firebase Pipeline Reader", roleId, permissionOverrides: [], status: "Active", initials: "FP", departmentId: null, createdAt: timestamp, lastLoginAt: null }; state.passwordHashes[id] = hash; }
    }
  }); } finally { await repository.close(); }
  await c.login();
  const status = await c.data("/settings/mcp-connections"), connection = status.connections[0];
  if (!connection.desiredEnabled) await c.data(`/settings/mcp-connections/${connection.id}/connect`, { baseRevision: connection.revision, requestId: "firebase_pipeline100_connect_0001" });
  const registries = await RegistryService.load(resolve(assets, "configs/runtime/pipeline_tools.json"), resolve(assets, "configs/runtime/pipeline_rules.json"));
  const validator = new RegistryValidator(registries, new Repository(null));
  const mcp = await createErpbridgeMcpSession({ baseURL: c.config.ERPBRIDGE_BASE_URL, token: c.config.ERPBRIDGE_MCP_TOKEN, timeoutMs: 60000, validator });
  try { for (const tool of await mcp.listTools()) {
    if (!["retrieve_indexed_erp_data", "discover_indexed_erp_sources", "search_indexed_erp_data", "get_indexed_representation", "get_canonical_erp_record"].some(name => tool.name === `${name}.rev_MS4wLjA`)) continue;
    await c.data("/registry/capabilities/import", { remoteName: tool.name, remoteHash: remoteContractHash(tool), decisionKey: `firebase_pipeline100_${digest(tool.name).slice(0,20)}`, allowedRoles: ["Platform Admin", "Client"], effectClass: "read", riskClass: "low", dataClass: "restricted", retryPolicy: "never", confirmed: true, note: "User-authorized emulator-only synthetic document retrieval. Exact separately deployed pipeline contract; no ERP write or real personal data." });
  } } finally { await mcp.close(); }
  const tools = await c.data("/registry/tools"), retrieval = tools.find(tool => tool.mcp_tool_name === "retrieve_indexed_erp_data"); assert(retrieval);
  const blueprint = { name: "Firebase 100-node stored-document retrieval test", description: "100 actual read-only ERPBridge calls to the existing synthetic document; encrypted Firebase emulator checkpoints. Repeated lookup of one record, not 100 distinct documents or production-scale performance.", trigger: { type: "manual" }, steps: Array.from({ length: 100 }, (_, index) => ({ id: `retrieve_${String(index + 1).padStart(3,"0")}`, action: retrieval.name, description: `Retrieve stored synthetic certificate · ${index + 1}/100`, parameters: { source_system_id: "qa_hr", source_entity: "employees", record_key: expectedRecord, limit: 1, max_text_chars: 400 } })) };
  const yaml = stringify(blueprint); await writeFile(resolve(output, "workflow-100.yaml"), yaml);
  const workflow = await c.data("/workflows", { yaml }, undefined, 201);
  const source = await c.data(`/workflows/${workflow.id}/yaml`); assert.equal(source.yaml, yaml); assert.equal(parse(source.yaml).steps.length, 100);
  const canvas = await c.data(`/workflows/${workflow.id}/canvas`); assert.equal(canvas.nodes.length, 100); assert.equal(canvas.edges.length, 99);
  await c.data(`/workflows/${workflow.id}/publish`, { baseVersion: source.version, baseHash: source.contentHash });
  const ready = await c.data(`/workflows/${workflow.id}/readiness`); assert.equal(ready.can_attempt_run, true);
  const command = { mode: "async-read", idempotencyKey: "firebase_pipeline100_read_0001", input: {} }, response = await c.request(`/workflows/${workflow.id}/run`, command);
  assert.equal(response.status, 202); assert.equal(response.body.meta.taskDispatch, "ENQUEUED"); const executionId = response.body.data.id;
  await writeFile(evidencePath, JSON.stringify({ profile: "firebase-pipeline-100-evidence/v1", workflowId: workflow.id, executionId, state: response.body.data.status, sourceSha256: digest(yaml), scope: "Native Firebase/Firestore emulator + real ERPBridge/pipeline reads; one synthetic record" }, null, 2));
  console.log(`Native queued workflow admitted: ${workflow.id} / ${executionId}. Waiting for 100 acknowledged document reads.`);
  let run, printed = -1; const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const result = await c.request(`/executions/${executionId}`);
    if (result.status === 200) { run = result.body.data; const count = Object.keys(run.stepOutputs ?? {}).length;
      if (Math.floor(count/10) !== printed) { printed = Math.floor(count/10); console.log(`Actual retrieval checkpoint: ${count}/100 · ${run.status}`); }
      if (!["PENDING", "RUNNING"].includes(run.status)) break;
    } else assert.equal(result.status, 503, `Unexpected progress HTTP ${result.status}`);
    await new Promise(done => setTimeout(done, 1500));
  }
  assert.equal(run?.status, "DONE", JSON.stringify({ status: run?.status, failure: run?.failure, summary: run?.agentSummary }));
  assert.equal(Object.keys(run.stepOutputs).length, 100);
  for (const step of blueprint.steps) { const value = run.stepOutputs[step.id]; assertHit(value.structuredContent); assert.equal(value._meta?.["io.workflow-engine/dispatch"]?.remoteName, "retrieve_indexed_erp_data.rev_MS4wLjA"); }
  const inspect = async () => { const repo = await c.open(); try { return await repo.readAuthoritative(state => ({ yaml: state.workflows[workflow.id].yaml, version: state.workflows[workflow.id].publishedVersion, run: state.executions[executionId], job: state.readJobs[executionId] })); } finally { await repo.close(); } };
  const before = await inspect(), taskId = assertReadTaskOutbox(before.job).taskId; assert.equal(before.run.status, "DONE"); assert.equal(before.job.state, "FINISHED");
  const repeated = await c.data(`/workflows/${workflow.id}/run`, command, undefined, 202); assert.equal(repeated.id, executionId);
  const after = await inspect(); assert.equal(after.yaml, yaml); assert.equal(after.version, 1); assert.deepEqual(after.run.stepOutputs, before.run.stepOutputs); assert.equal(assertReadTaskOutbox(after.job).taskId, taskId);
  const template = await c.data("/workflows/templates", { name: "Firebase reusable 100-node document retrieval", description: blueprint.description, category: "Local acceptance", yaml, steps: 100 }, undefined, 201);
  const evidence = { profile: "firebase-pipeline-100-evidence/v1", qualifiedAt: new Date().toISOString(), passed: true, workflowId: workflow.id, executionId, state: run.status, outputs: 100, nodes: 100, canvasEdges: 99, taskDispatch: "ENQUEUED", taskId, jobState: before.job.state, recordKey: expectedRecord, certificateReference: expectedReference, verificationPhrase: expectedPhrase, returnedText: run.stepOutputs.retrieve_100.structuredContent.hits[0].text, freshStorageOwnersVerified: 2, duplicateRunSameExecution: true, templateId: template.id, sourceSha256: digest(yaml), elapsedMs: run.durationMs, scope: "Native Firebase/Firestore emulator + separately deployed actual ERPBridge/pipeline; 100 repeated reads of one synthetic document, no mocks, ERP writes or production data" };
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2)); console.log("PASS: 100 real document results committed through native Firebase tasks; fresh encrypted Firestore reads and idempotency passed.");
}
async function configureProvider() {
  const c = await context(); await c.login(); console.log("Waiting for existing OpenRouter credential on stdin; input is not echoed or saved in source/evidence.");
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  let key = await new Promise((done, reject) => { let buffer = ""; const receive = bytes => { buffer += bytes.toString(); if (!/[\r\n]/.test(buffer)) return; process.stdin.off("data",receive); process.stdin.pause(); if(process.stdin.isTTY) process.stdin.setRawMode(false); done(buffer.split(/[\r\n]/)[0].trim()); }; process.stdin.on("data",receive); process.stdin.once("end",()=>reject(new Error("Credential input closed"))); process.stdin.resume(); });
  assert(key); const check = await fetch("https://openrouter.ai/api/v1/auth/key", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000) }); console.log(`Credential check HTTP ${check.status}`); assert(check.ok, "Existing provider credential is unavailable"); await check.body?.cancel();
  const provider = await c.data("/providers", { name: "Real OpenRouter · Firebase pipeline synthetic QA", type: "openai_compatible", baseUrl: "https://openrouter.ai/api/v1", apiKey: key, model: "deepseek/deepseek-v4.1-flash", temperature: 0, egressPolicy: { approvedOrigin: "https://openrouter.ai", interactiveDataClasses: ["restricted"], runtimeAnalysisDataClasses: [], runtimeAgentDataClasses: [], confirmed: true } }, undefined, 201); key = "";
  const tested = await c.data(`/providers/${provider.id}/test`, {}); assert.equal(tested.ok, true, "Real provider test did not pass"); await c.data(`/providers/${provider.id}/activate`, {}); console.log("Real provider tested and activated in the isolated encrypted Firebase namespace.");
}
async function rerunSavedReadOnly() {
  // Explicit operator-started new read run, never resume/replay of an uncertain
  // effect. Preserve the original failed run and use the same saved workflow.
  const c=await context(); await c.login(); const previous=JSON.parse(await readFile(evidencePath,"utf8"));
  const stopped=await c.data(`/executions/${previous.executionId}`); assert.equal(stopped.status,"FAILED","Only an explicitly inspected failed read run can start a new acceptance attempt");
  const source=await c.data(`/workflows/${previous.workflowId}/yaml`), blueprint=parse(source.yaml); assert.equal(blueprint.steps.length,100);
  assert(blueprint.steps.every(step=>step.parameters?.record_key===expectedRecord&&step.action.includes("retrieve_indexed_erp_data")),"Only the fixed read-only synthetic certificate workflow may be retried");
  const failedAttempts=[...(previous.failedAttempts??[]),{executionId:stopped.id,status:stopped.status,outputs:Object.keys(stopped.stepOutputs??{}).length,failure:stopped.failure,summary:stopped.agentSummary}];
  assert(failedAttempts.length<=2,"Repeated failure retained; stop and diagnose before more load");
  const command={mode:"async-read",idempotencyKey:`firebase_pipeline100_new_read_${randomBytes(8).toString("hex")}`,input:{}};
  const response=await c.request(`/workflows/${previous.workflowId}/run`,command); assert.equal(response.status,202); assert.equal(response.body.meta.taskDispatch,"ENQUEUED"); const id=response.body.data.id;
  await writeFile(evidencePath,JSON.stringify({...previous,executionId:id,state:"PENDING",failedAttempts},null,2));
  console.log(`Explicit new read-only attempt ${id}; original failed results preserved.`);
  let run,printed=-1; const deadline=Date.now()+300000;
  while(Date.now()<deadline){const r=await c.request(`/executions/${id}`);if(r.status===200){run=r.body.data;const count=Object.keys(run.stepOutputs??{}).length;if(Math.floor(count/10)!==printed){printed=Math.floor(count/10);console.log(`Actual retrieval checkpoint: ${count}/100 · ${run.status}`);}if(!["PENDING","RUNNING"].includes(run.status))break;}else assert.equal(r.status,503);await new Promise(done=>setTimeout(done,1500));}
  await writeFile(evidencePath,JSON.stringify({...previous,executionId:id,state:run?.status,outputs:Object.keys(run?.stepOutputs??{}).length,failure:run?.failure,failedAttempts},null,2));
  assert.equal(run?.status,"DONE",JSON.stringify({status:run?.status,failure:run?.failure}));assert.equal(Object.keys(run.stepOutputs).length,100);
  for(const step of blueprint.steps){assertHit(run.stepOutputs[step.id].structuredContent);assert.equal(run.stepOutputs[step.id]._meta?.["io.workflow-engine/dispatch"]?.remoteName,"retrieve_indexed_erp_data.rev_MS4wLjA");}
  const inspect=async()=>{const repo=await c.open();try{return await repo.readAuthoritative(st=>({yaml:st.workflows[previous.workflowId].yaml,version:st.workflows[previous.workflowId].publishedVersion,run:st.executions[id],job:st.readJobs[id]}));}finally{await repo.close();}};
  const first=await inspect(),taskId=assertReadTaskOutbox(first.job).taskId;assert.equal(first.job.state,"FINISHED");assert.equal(first.run.status,"DONE");
  const repeated=await c.data(`/workflows/${previous.workflowId}/run`,command,undefined,202);assert.equal(repeated.id,id);
  const second=await inspect();assert.equal(second.yaml,source.yaml);assert.deepEqual(second.run.stepOutputs,first.run.stepOutputs);assert.equal(assertReadTaskOutbox(second.job).taskId,taskId);
  const template=await c.data("/workflows/templates",{name:"Firebase reusable 100-node document retrieval",description:blueprint.description,category:"Local acceptance",yaml:source.yaml,steps:100},undefined,201);
  await writeFile(evidencePath,JSON.stringify({profile:"firebase-pipeline-100-evidence/v1",qualifiedAt:new Date().toISOString(),passed:true,workflowId:previous.workflowId,executionId:id,state:"DONE",nodes:100,outputs:100,canvasEdges:99,taskDispatch:"ENQUEUED",taskId,jobState:first.job.state,recordKey:expectedRecord,certificateReference:expectedReference,verificationPhrase:expectedPhrase,returnedText:run.stepOutputs.retrieve_100.structuredContent.hits[0].text,freshStorageOwnersVerified:2,duplicateRunSameExecution:true,templateId:template.id,sourceSha256:digest(source.yaml),elapsedMs:run.durationMs,failedAttempts,scope:previous.scope},null,2));
  console.log("PASS: all 100 actual pipeline results saved through Firebase; original failure retained, fresh storage and duplicate-admission checks passed.");
}
async function reviewRemainingReadTools() {
  const c=await context();await c.login();const registries=await RegistryService.load(resolve(assets,"configs/runtime/pipeline_tools.json"),resolve(assets,"configs/runtime/pipeline_rules.json"));
  const session=await createErpbridgeMcpSession({baseURL:c.config.ERPBRIDGE_BASE_URL,token:c.config.ERPBRIDGE_MCP_TOKEN,timeoutMs:60000,validator:new RegistryValidator(registries,new Repository(null))});
  try{for(const tool of await session.listTools()){
    if(!["get_indexed_representation.rev_MS4wLjA","get_canonical_erp_record.rev_MS4wLjA"].includes(tool.name))continue;
    await c.data("/registry/capabilities/import",{remoteName:tool.name,remoteHash:remoteContractHash(tool),decisionKey:`firebase_pipeline100_${digest(tool.name).slice(0,20)}`,allowedRoles:["Platform Admin","Client"],effectClass:"read",riskClass:"low",dataClass:"restricted",retryPolicy:"never",confirmed:true,note:"User-authorized emulator-only synthetic document retrieval. Exact separately deployed pipeline contract; no ERP write or real personal data."});
  }}finally{await session.close();}console.log("Remaining exact representation/canonical read contracts reviewed in the isolated namespace.");
}
async function qualifyChat() {
  const c = await context(); await c.login("firebase.reader@example.test");
  const chat = await c.data("/chat/sessions", { title: "Firebase: real stored certificate retrieval", idempotencyKey: `firebase_pipeline_chat_${randomBytes(8).toString("hex")}` }, undefined, 201);
  const admitted = await c.data(`/chat/sessions/${chat.id}/messages`, { content: "Find the stored image certificate for Lakshan QA Sample in source system qa_hr, entity employees. Retrieve it through the indexed ERPBridge tools and give the employee ID, certificate reference, issue date and verification phrase from the uploaded document. This is synthetic local QA; do not change records or send email.", delivery: "async-chat", idempotencyKey: `firebase_pipeline_query_${randomBytes(8).toString("hex")}`, model: "deepseek/deepseek-v4.1-flash" }, undefined, 202);
  assert.equal(admitted.taskDispatch, "ENQUEUED"); let op; const deadline = Date.now()+240000;
  while(Date.now()<deadline) { const response=await c.request(`/chat/operations/${admitted.operation.id}`); if(response.status===200){ op=response.body.data.operation; if(!["QUEUED","RUNNING"].includes(op.status)) break; } else assert.equal(response.status,503); await new Promise(done=>setTimeout(done,1500)); }
  const saved = await c.data(`/chat/sessions/${chat.id}`), message = saved.messages.find(item=>item.id===op?.assistantMessageId);
  const evidence = { qualifiedAt:new Date().toISOString(), sessionId:chat.id, operationId:op?.id, status:op?.status, taskDispatch:admitted.taskDispatch, modelBinding:admitted.operation.modelBinding, text:message?.text, artifacts:message?.artifacts };
  await writeFile(resolve(output,"chat-evidence.json"),JSON.stringify(evidence,null,2));
  assert.equal(op?.status,"ANSWERED"); assert.equal(message?.artifacts?.readOutcome,"READS_COMPLETED"); assert.equal(message.artifacts.narrativeRejected,false);
  assert(message.text.includes(expectedRecord)); assert(message.text.includes(expectedReference)); assert(message.text.toLowerCase().includes(expectedPhrase));
  assert(message.artifacts.toolSteps.some(step=>step.status==="SUCCEEDED" && step.result?._meta?.["io.workflow-engine/dispatch"]?.remoteName?.endsWith(".rev_MS4wLjA")));
  console.log(`PASS: reader chat ${chat.id} returned independently retrieved certificate facts through real model + native Firebase task + ERPBridge/pipeline.`);
}
try {
  if(mode==="--prepare") await prepare();
  else if(mode==="--workflow") await qualifyWorkflow();
  else if(mode==="--configure-provider") await configureProvider();
  else if(mode==="--rerun-readonly") await rerunSavedReadOnly();
  else if(mode==="--review-remaining") await reviewRemainingReadTools();
  else if(mode==="--chat") await qualifyChat();
  else if(mode==="--inspect") { const c=await context(); await c.login(); const evidence=JSON.parse(await readFile(evidencePath,"utf8")); const run=await c.data(`/executions/${evidence.executionId}`); console.log(JSON.stringify({workflowId:evidence.workflowId,executionId:run.id,status:run.status,outputs:Object.keys(run.stepOutputs??{}).length})); }
  else throw new Error("Choose --prepare, --workflow, --configure-provider, --chat or --inspect");
} catch(error) { console.error(`Firebase pipeline QA stopped: ${error.message}`); process.exitCode=1; }

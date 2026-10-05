import {readFile, writeFile, mkdtemp} from "node:fs/promises";
import {resolve} from "node:path";
import assert from "node:assert/strict";
import {loadConfig} from "../src/config/config.ts";
import {Repository} from "../src/repository/store.ts";
import {RegistryService} from "../src/registry/service.ts";
import {RegistryValidator} from "../src/validator/registry-validator.ts";
import {createErpbridgeMcpSession} from "../src/tools/erpbridge-mcp-client.ts";
import {admissionAuthorizer} from "../src/registry/capability-admission.ts";
import {importDiscoveredCapability} from "../src/registry/capability-import.ts";
import {remoteContractHash} from "../src/registry/discovered-contract.ts";
import {dispatchReadTool} from "../src/tools/read-tool-broker.ts";
const credentials = JSON.parse(await readFile("../tmp/pipeline-local/session.json", "utf8"));
const config = loadConfig({APP_ENV:"development", STORAGE_DRIVER:"memory", JWT_SECRET:credentials.jwt,
  MCP_MODE:"remote", MCP_TRANSPORT:"erpbridge-mcp", ERPBRIDGE_BASE_URL:"http://127.0.0.1:18080",
  ERPBRIDGE_MCP_TOKEN:credentials.mcpToken, ERPBRIDGE_ROLE_MAP:'{"Platform Admin":"platform_admin"}'});
const repository = new Repository(null);
// Never modify the running application's release registry during a standalone check.
const checkDir = await mkdtemp(resolve("../tmp/pipeline-local/governed-check-"));
await writeFile(resolve(checkDir, "tools.json"), "[]");
await writeFile(resolve(checkDir, "rules.json"), "[]");
const registries = await RegistryService.load(resolve(checkDir, "tools.json"), resolve(checkDir, "rules.json"));
await repository.mutate(state => {state.users.qa = {id:"qa", name:"Synthetic retrieval tester",email:"qa@example.test",
  roleId:"role_admin",permissionOverrides:[],status:"Active",initials:"QA",departmentId:null,createdAt:new Date().toISOString(),lastLoginAt:null};});
const actor = await repository.effectiveUser("qa"), validator = new RegistryValidator(registries,repository);
const session = await createErpbridgeMcpSession({baseURL:config.erpbridgeBaseURL,token:config.erpbridgeMcpToken,
  timeoutMs:30000,validator,admissionAuthorizer:admissionAuthorizer(repository,registries)});
try {
  const remoteTools = await session.listTools();
  for (const name of ["retrieve_indexed_erp_data", "discover_indexed_erp_sources"]) {
  const remote = remoteTools.find(tool => tool.name === `${name}.rev_MS4wLjA`);
  assert(remote);
  await importDiscoveredCapability({repository,registries,session,user:actor,body:{remoteName:remote.name,
    remoteHash:remoteContractHash(remote),decisionKey:"pipeline-governed-retrieval-qa",allowedRoles:["Platform Admin"],
    effectClass:"read",riskClass:"low",dataClass:"restricted",retryPolicy:"never",confirmed:true,note:"Explicit synthetic local image retrieval qualification."}});
  }
  const services = {config,repository,registries,validator,erpbridgeSession:session};
  const catalog = await dispatchReadTool(services, actor.id, "discover_indexed_erp_sources", {});
  assert(Array.isArray(catalog.structuredContent.identity_filters));
  console.log("Source discovery through ERPBridge succeeded.");
  const parameters = {source_system_id:"qa_hr",source_entity:"employees",record_key:"EMP-QA-1042"};
  const started = performance.now();
  const exact = await dispatchReadTool(services,actor.id,"retrieve_indexed_erp_data",parameters);
  const content = exact.structuredContent;
  assert.equal(content.retrieval_mode,"exact"); assert.equal(content.hits.length,1);
  const text = content.hits[0].text;
  assert(text.includes("QA-7382-ORCHID")); assert(text.includes("silver orchid bridge"));
  const wrong = await dispatchReadTool(services,actor.id,"retrieve_indexed_erp_data",{...parameters,source_system_id:"wrong_hr"});
  assert.equal(wrong.structuredContent.hits.length,0);
  const semantic = await dispatchReadTool(services,actor.id,"retrieve_indexed_erp_data",{source_system_id:"qa_hr",source_entity:"employees",q:"Lakshan QA Sample certificate"});
  assert.equal(semantic.structuredContent.hits[0].record_key,"EMP-QA-1042");
  const bounded = await dispatchReadTool(services,actor.id,"retrieve_indexed_erp_data",{...parameters,max_text_chars:32});
  assert.equal(bounded.structuredContent.text_chars_returned,32); assert(bounded.structuredContent.hits[0].text_truncated);
  const login = await fetch("http://127.0.0.1:18082/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:"reader.qa@example.test",password:"Pipeline-QA-2026!"})});
  const reader = (await login.json()).data;
  const denied = await fetch("http://127.0.0.1:18082/api/pipeline/v1/files/documents",{method:"POST",headers:{Authorization:`Bearer ${reader.accessToken}`}});
  assert.equal(denied.status,403); await denied.body?.cancel();
  const evidence = {qualifiedAt:new Date().toISOString(),passed:true,exactLookup:content.retrieval_mode,
    recordKey:content.hits[0].record_key,ocrText:text,exactPipelineMs:content.took_ms,
    governedCallSequenceMs:Math.round(performance.now()-started),semanticScore:semantic.structuredContent.hits[0].score,
    wrongScopeHits:wrong.structuredContent.hits.length,boundedTextChars:32,readerUploadStatus:denied.status,
    dispatch:exact._meta?.["io.workflow-engine/dispatch"],realModelChat:"not executed by this bridge-only check; see saved chat evidence or run qualify-pipeline-chat.mjs"};
  await writeFile("../tmp/pipeline-local/retrieval-evidence.json",JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence,null,2));
} finally {await session.close(); await repository.close();}

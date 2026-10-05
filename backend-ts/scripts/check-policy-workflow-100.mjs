// Diagnostic acceptance: only creates synthetic local QA drafts/templates.
// Never changes policy settings or executes business tools.
import assert from "node:assert/strict";
import {stringify, parse} from "yaml";
import {readFile, writeFile} from "node:fs/promises";
const base = "http://127.0.0.1:18082/api";
async function login(email) {
  const response = await fetch(`${base}/auth/login`, {method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({email, password: "Pipeline-QA-2026!"})});
  assert(response.ok, `QA login HTTP ${response.status}`);
  return (await response.json()).data.accessToken;
}
const token = await login("pipeline.qa@example.test");
async function request(path, body, method = body === undefined ? "GET" : "POST", actor = token) {
  const response = await fetch(`${base}${path}`, {method, headers: {Authorization: `Bearer ${actor}`, "Content-Type": "application/json"},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(60000)});
  return {status: response.status, body: await response.json()};
}
async function data(path, body, method) {
  const result = await request(path, body, method);
  assert(result.status >= 200 && result.status < 300, `${path}: HTTP ${result.status} ${JSON.stringify(result.body)}`);
  return result.body.data;
}
const settings = await data("/settings");
const flags = {remote: settings.rbac.enabled === true, local: settings.rbac.localPolicyAgentEnabled === true};
const catalog = await data("/registry/tools");
const tools = Array.isArray(catalog) ? catalog : catalog.items;
const tool = tools.find(item => item.mcp_tool_name === "retrieve_indexed_erp_data" && item.is_read_only);
assert(tool, "Reviewed pipeline retrieval tool must be present");
const blueprint = {name: "100-node synthetic QA reusable workflow", description: "Save/reopen/reuse acceptance only; no business execution requested",
  trigger: {type: "manual"}, steps: Array.from({length: 100}, (_, index) => ({id: `read_${String(index + 1).padStart(3, "0")}`,
    description: `Synthetic scoped document read ${index + 1}`, action: tool.name,
    parameters: {source_system_id: "qa_hr", source_entity: "employees", record_key: "EMP-QA-1042", limit: 1, max_text_chars: 400}}))};
const yaml = stringify(blueprint, {lineWidth: 0});
const exportPath = "../tmp/pipeline-local/workflow-100-nodes.yaml";
await writeFile(exportPath, yaml);
assert.deepEqual(parse(await readFile(exportPath, "utf8")), blueprint);
const existing = await data("/workflows?limit=100");
const workflow = existing.find(item => item.name === blueprint.name && item.yaml === yaml) ??
  await data("/workflows", {yaml, tags: ["synthetic-qa", "100-node-check"]});
const reopened = await data(`/workflows/${workflow.id}/yaml`);
assert.equal(reopened.yaml, yaml);
assert.equal(parse(reopened.yaml).steps.length, 100);
const canvas = await data(`/workflows/${workflow.id}/canvas`);
assert.equal(canvas.nodes.length, 100);
assert.equal(canvas.edges.length, 99);
const readiness = await data(`/workflows/${workflow.id}/readiness`);
const published = await request(`/workflows/${workflow.id}/publish`, {baseVersion: reopened.version, baseHash: reopened.contentHash,
  versionNote: "Synthetic 100-node save/reuse QA. Not executed."});
const template = await data("/workflows/templates", {name: "100-node synthetic QA reusable template", description: blueprint.description,
  yaml, steps: 100, category: "Synthetic QA", tags: ["100-node-check"]});
const reused = await data(`/workflows/templates/${template.id}/use`, {name: "100-node synthetic QA template reuse"});
assert.equal(parse((await data(`/workflows/${reused.id}/yaml`)).yaml).steps.length, 100);
const invalidCases = [];
for (const [name, change] of [["unknown-tool", value => {value.steps[0].action = "nonexistent.qa.tool";}],
  ["wrong-argument-type", value => {value.steps[0].parameters.source_system_id = 42;}],
  ["duplicate-node-id", value => {value.steps[1].id = value.steps[0].id;}],
  ["missing-required-argument", value => {delete value.steps[0].parameters.source_entity;}]]) {
  const invalid = structuredClone(blueprint); invalid.name = `QA validation probe - ${name}`; change(invalid);
  const result = await request("/workflows", {yaml: stringify(invalid)});
  const observation = {name, createStatus: result.status};
  if (result.status === 201) {
    observation.workflowId = result.body.data.id;
    const probe = await data(`/workflows/${observation.workflowId}/readiness`);
    observation.readiness = {validationPassed: probe.validation?.passed, canRun: probe.canRun, issues: probe.issues};
    const blocked = await request(`/workflows/${observation.workflowId}/publish`, {});
    observation.publishStatus = blocked.status;
    observation.publicationError = blocked.status >= 400 ? blocked.body : null;
    observation.executionReadiness = blocked.body.data?.executionReadiness;
    const after = await data(`/workflows/${observation.workflowId}/readiness`);
    observation.afterPublication = {canRun: after.canRun, canAttemptRun: after.can_attempt_run, issues: after.issues,
      compilation: after.compilation};
    const refusedRun = await request(`/workflows/${observation.workflowId}/run`, {input: {}});
    observation.runStatus = refusedRun.status;
    observation.runResponse = refusedRun.body;
    assert.equal(after.can_attempt_run, false, `${name} must remain non-executable`);
    assert(refusedRun.status >= 400, `${name} must fail before business dispatch`);
  } else assert.equal(result.status, 422, `${name} must be rejected without creating a workflow`);
  invalidCases.push(observation);
}
const readerToken = await login("reader.qa@example.test");
const denied = await request("/workflows", {yaml}, "POST", readerToken);
assert.equal(denied.status, 403);
assert.deepEqual((await data("/settings")).rbac, settings.rbac, "Check must leave policy settings unchanged");
const finalReadiness = await data(`/workflows/${workflow.id}/readiness`);
const simulation = await data(`/workflows/${workflow.id}/run`, {dryRun: true, input: {}});
assert.equal(simulation.plan_valid, true);
assert.equal(simulation.planned_steps.length, 100);
const evidence = {checkedAt: new Date().toISOString(), policySwitches: flags, policySettingsUnchanged: true,
  workflowId: workflow.id, reopenedNodes: 100, canvasNodes: canvas.nodes.length, canvasEdges: canvas.edges.length,
  sourceBytes: Buffer.byteLength(yaml), readiness: {validation: readiness.validation, bridge: readiness.bridge, canRun: readiness.canRun,
    issues: readiness.issues}, afterPublication: {canRun: finalReadiness.canRun, canAttemptRun: finalReadiness.can_attempt_run,
    issues: finalReadiness.issues, compilation: finalReadiness.compilation}, staticSimulation: {valid: simulation.plan_valid, steps: simulation.planned_steps.length},
  publication: {status: published.status, data: published.body.data, error: published.body.message, meta: published.body.meta},
  templateId: template.id, reusedWorkflowId: reused.id, invalidCases, readerCreateStatus: denied.status,
  businessToolsExecuted: 0, applicationPersistence: "memory-only local QA; no application restart durability claim",
  exportPath: "tmp/pipeline-local/workflow-100-nodes.yaml"};
await writeFile("../tmp/pipeline-local/policy-workflow-100-evidence.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({...evidence, publication: {status: published.status, executionReadiness: published.body.data?.executionReadiness,
  error: published.status >= 400 ? published.body : null}}, null, 2));

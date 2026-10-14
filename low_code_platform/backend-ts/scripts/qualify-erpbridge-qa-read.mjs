// One literal, explicitly reviewed synthetic GET via the REAL governed backend
// facade. All admission/validator state is a disposable memory repository.
// Does not change the product registry, use a model or publish/run a workflow.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { qaReadTool } from "./seed-erpbridge-qa-read.mjs";
import { assertQaBridgeContainer, qaBaseURL, qaProject } from "./erpbridge-docker-qa.mjs";
import { canonicalJSONBytes } from "../src/core/canonical-json.ts";
import { toolSchema } from "../src/registry/schemas.ts";
import { RegistryService } from "../src/registry/service.ts";
import { Repository } from "../src/repository/store.ts";
import { RegistryValidator } from "../src/validator/registry-validator.ts";
import { createErpbridgeMcpSession } from "../src/tools/erpbridge-mcp-client.ts";
import { admissionAuthorizer, observeCapabilities, reviewCapability } from "../src/registry/capability-admission.ts";

export function qaReviewedDefinition(resource) {
  const expected = qaReadTool(), actual = structuredClone(resource?.spec);
  // Go's empty required slice is omitted on serialization; semantics unchanged.
  delete expected.spec.inputSchema.required;
  delete expected.spec.security.allowedRoles;
  // The bridge freezes its configured downstream origin at resource admission.
  expected.spec.execution.approvedOrigins = ["http://mock-erp:8081"];
  if (actual?.inputSchema?.required?.length === 0) delete actual.inputSchema.required;
  if (actual?.security?.allowedRoles?.length === 0) delete actual.security.allowedRoles;
  if (resource?.kind !== expected.kind || resource?.apiVersion !== expected.apiVersion ||
    resource?.metadata?.name !== expected.metadata.name || resource?.metadata?.version !== "1.0.0" ||
    !/^[a-f0-9]{64}$/.test(resource?.metadata?.resourceDigest ?? "") ||
    !canonicalJSONBytes(actual).equals(canonicalJSONBytes(expected.spec)))
    throw new Error("Remote resource is not the exact explicitly reviewed synthetic GET contract");
  return toolSchema.parse({ tool_id: "LOCAL-QA-DEPARTMENTS-READ", name: "qa_list_departments", mcp_tool_name: "qa_list_departments",
    description: "LOCAL QA Department GET only; not production integration", input_schema: expected.spec.inputSchema,
    required_parameters: [], allowed_roles: ["Platform Admin"], is_read_only: true, risk_level: "low", side_effects: [],
    bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: resource.metadata.resourceDigest,
      remote_roles: [], output_schema: expected.spec.outputSchema } });
}

export async function main(args) {
  if (args.length !== 1 || args[0] !== "--run-read") throw new Error("Use --run-read for one explicitly governed synthetic GET");
  const { stdout } = await promisify(execFile)("docker", ["inspect", `${qaProject}-erpbridge-server-1`], { timeout: 15_000, maxBuffer: 1_000_000, windowsHide: true });
  const containers = JSON.parse(stdout);
  if (containers.length !== 1) throw new Error("Expected one exact QA bridge");
  const token = assertQaBridgeContainer(containers[0]);
  const response = await fetch(`${qaBaseURL}/apis/erpbridge.io/v1/tools?name=qa_list_departments&version=1.0.0`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error("Exact synthetic tool resource is unavailable");
  const resources = await response.json();
  if (!Array.isArray(resources) || resources.length !== 1) throw new Error("Expected one exact synthetic resource");
  const definition = qaReviewedDefinition(resources[0]);
  const directory = await mkdtemp(resolve(tmpdir(), "lcwe-qa-read-")), toolPath = resolve(directory, "tools.json"), rulePath = resolve(directory, "rules.json");
  const repository = new Repository(null);
  let session;
  try {
    await writeFile(toolPath, JSON.stringify([definition]), { flag: "wx" });
    await writeFile(rulePath, "[]", { flag: "wx" });
    const registries = await RegistryService.load(toolPath, rulePath), validator = new RegistryValidator(registries, repository);
    const createdAt = new Date().toISOString();
    await repository.mutate(state => { state.users.local_qa = { id: "local_qa", name: "Local synthetic reviewer", email: "qa@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "QA", departmentId: null, createdAt, lastLoginAt: null }; });
    const user = await repository.effectiveUser("local_qa"), identity = { userId: user.id, localRole: user.role, erpbridgeRole: null };
    session = await createErpbridgeMcpSession({ baseURL: qaBaseURL, token, timeoutMs: 15_000, validator, admissionAuthorizer: admissionAuthorizer(repository, registries) });
    const yaml = stringify({ name: "LOCAL synthetic Department qualification", description: "One explicitly reviewed MockERP GET; no production data or email", trigger: { type: "manual" }, steps: [{ id: "departments", action: definition.name, parameters: {} }] });
    const issued = await validator.validateAndIssueToken("local.qa.read", yaml, user.role);
    if (!issued.result.passed || !issued.token) throw new Error("Synthetic read validation failed");
    const evaluated = await validator.evaluateResolvedStep("local.qa.read", yaml, 0, {}, issued.token, identity);
    if (!evaluated.capability) throw new Error("Synthetic read dispatch was not authorized");
    try { await session.clientFor(definition).execute(definition.name, evaluated.capability, {}, identity); throw new Error("Unreviewed read was unexpectedly admitted"); }
    catch (error) { if (!/unreviewed, disabled or blocked/.test(error.message)) throw error; }
    console.log("Before review: denied by capability admission; no ERP dispatch.");
    const observed = await observeCapabilities({ repository, registries, session, user });
    const observation = observed.observations[0];
    await reviewCapability({ repository, registries, session, user, capabilityId: observation.capabilityId, body: {
      observationId: observation.id, contractHash: observation.contractHash, decisionKey: "explicit-local-qa-department-read",
      effectClass: "read", riskClass: "low", dataClass: "internal", retryPolicy: "never", note: "Explicit literal LOCAL MockERP GET review in disposable repository; conservative local internal classification" } });
    const start = performance.now();
    const result = await session.clientFor(definition).execute(definition.name, evaluated.capability, {}, identity);
    if (!Array.isArray(result.structuredContent?.data)) throw new Error("Department read returned no confirmed data array");
    console.log(`After explicit review: governed exact-revision GET passed in ${Math.round(performance.now() - start)} ms; ${result.structuredContent.data.length} synthetic Department rows; validated structured output and dispatch provenance retained.`);
    try { await session.clientFor(definition).execute(definition.name, evaluated.capability, {}, identity); throw new Error("Consumed capability was unexpectedly reusable"); }
    catch (error) { if (!/consumed|not minted|invalid|expired/i.test(error.message)) throw error; }
    console.log("Consumed permit replay denied. Product registry unchanged; no ERP writes, emails, models or published-workflow execution qualified.");
  } finally {
    await session?.close(); await repository.close();
    await unlink(toolPath).catch(error => { if (error.code !== "ENOENT") throw error; });
    await unlink(rulePath).catch(error => { if (error.code !== "ENOENT") throw error; });
    await rmdir(directory);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(`Governed synthetic read qualification did not pass: ${error.name}. No business execution claimed.`); process.exitCode = 1; }
}

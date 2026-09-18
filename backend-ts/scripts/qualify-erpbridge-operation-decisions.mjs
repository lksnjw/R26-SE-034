// Read-only qualification against the already-running isolated Docker bridge.
// No bridge files, configuration, resource definitions or business effects are changed.
import { createQaWorkspace, qaModelReadBlueprint } from "./erpbridge-workspace-qa.mjs";
import { stringify } from "yaml";

if (process.argv.length !== 3 || process.argv[2] !== "--run-synthetic-decisions")
  throw new Error("Use --run-synthetic-decisions against the existing isolated Docker QA stack");
const workspace = await createQaWorkspace({ modelReadFixture: true });
try {
  const login = await workspace.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "qa@example.test", password: "Local-QA-only-2026!" } });
  if (login.statusCode !== 200) throw new Error("Local QA login failed");
  const headers = { authorization: `Bearer ${login.json().data.accessToken}` };
  const request = async (method, url, payload, expected = 200) => {
    const response = await workspace.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
    if (response.statusCode !== expected) throw new Error(`Synthetic decision ${method} failed with status ${response.statusCode}`);
    return response.json().data;
  };
  for (const kind of ["analysis", "agent"]) for (const selected of [true, false]) {
    const blueprint = qaModelReadBlueprint(kind);
    blueprint.metadata = { controlFlow: { schemaVersion: "read-control-flow/v1", root: { kind: "sequence", nodes: [
      { kind: "action", nodeId: "departments" }, { kind: "if", id: "include_count", predicate: { kind: "literal", value: selected },
        then: { kind: "sequence", nodes: [{ kind: "action", nodeId: "count" }] }, else: { kind: "sequence", nodes: [] } },
    ] } } };
    const draft = await request("POST", "/api/workflows", { yaml: stringify(blueprint) }, 201);
    const published = await request("POST", `/api/workflows/${draft.id}/publish`, {});
    if (published.compiledOperation?.schemaVersion !== "workflow-operation-ir/v4") throw new Error("Decision IR was not separately versioned");
    const command = { mode: "async-operation", idempotencyKey: `docker-decision-${kind}-${selected}-0001`, input: {} };
    const run = await request("POST", `/api/workflows/${draft.id}/run`, command, 202), deadline = Date.now() + 15000;
    let saved;
    do {
      saved = await request("GET", `/api/executions/${run.id}`);
      if (!["PENDING", "RUNNING"].includes(saved.status)) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    const rows = saved.stepOutputs?.departments?.structuredContent?.data;
    if (saved.status !== "DONE" || !Array.isArray(rows) || rows.length !== 8 || saved.pendingApproval ||
        saved.readProgress?.decisions?.include_count?.selected !== (selected ? "then" : "else")) throw new Error("Actual Docker read or selected path was not confirmed");
    if (selected ? saved.stepOutputs?.count?.structuredContent?.departmentCount !== rows.length :
        saved.stepOutputs?.count !== undefined || saved.tokens?.total !== 0 || saved.readProgress?.attempts?.count?.status !== "SKIPPED")
      throw new Error("Model answer or explicit non-selected no-model evidence did not match");
    const before = await workspace.repository.snapshot();
    const replay = await request("POST", `/api/workflows/${draft.id}/run`, command, 202);
    const after = await workspace.repository.snapshot();
    if (replay.id !== run.id || JSON.stringify(before.executionEvents[run.id]) !== JSON.stringify(after.executionEvents[run.id])) throw new Error("Replay changed decision run evidence");
    console.log(`LOCAL Docker ${kind}/${selected ? "Yes" : "No"}: v4 decision DONE; 8 actual synthetic rows; ${selected ? "bounded fixture answer matches" : "model skipped with no answer or token usage"}; replay unchanged; no writes or email.`);
  }
} finally { await workspace.close(); }

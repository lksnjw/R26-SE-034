// Explicit disposable qualification: normal HTTP handlers/worker plus actual
// Docker MCP, synthetic ERP data and an injected LOCAL model fixture only.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createQaWorkspace } from "./erpbridge-workspace-qa.mjs";

export async function main(args) {
  if (args.length !== 1 || args[0] !== "--run-reviewed-model-reads") throw new Error("Use the explicit synthetic model-read qualification flag");
  const workspace = await createQaWorkspace({ modelReadFixture: true });
  try {
    const login = await workspace.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "qa@example.test", password: "Local-QA-only-2026!" } });
    if (login.statusCode !== 200) throw new Error("Local QA authentication failed");
    const headers = { authorization: `Bearer ${login.json().data.accessToken}` };
    const request = async (method, url, payload, expected) => {
      const response = await workspace.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
      if (response.statusCode !== expected) throw new Error(`Local model-read ${method} did not return its expected status`);
      return response.json().data;
    };
    for (const kind of ["analysis", "agent"]) {
      const candidate = await request("POST", "/api/synthesis", { prompt: `Create a local workflow to read synthetic Departments and count them with ${kind}.` }, 200);
      if (!candidate.validation.passed || candidate.execution_profile_issues.length || candidate.candidate.generation_metadata.promptTemplateVersion !== "prompt/candidate/v8")
        throw new Error("Local synthesis did not prove the expected versioned draft");
      const draft = await request("POST", "/api/workflows", { yaml: candidate.yaml }, 201);
      await request("POST", `/api/workflows/${draft.id}/publish`, {}, 200);
      const readiness = await request("GET", `/api/workflows/${draft.id}/readiness`, null, 200);
      if (!readiness.can_attempt_run || readiness.effectProfile !== "read-only") throw new Error("Local model-read publication is not ready");
      const command = { mode: "async-operation", idempotencyKey: `explicit-model-read-${kind}-0001`, input: {} };
      const run = await request("POST", `/api/workflows/${draft.id}/run`, command, 202), deadline = Date.now() + 15_000;
      let saved;
      do {
        saved = await request("GET", `/api/executions/${run.id}`, null, 200);
        if (!['PENDING', 'RUNNING'].includes(saved.status)) break;
        await new Promise(resolve => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      const actualRows = saved.stepOutputs?.departments?.structuredContent?.data;
      if (saved.status !== "DONE" || !Array.isArray(actualRows) || !actualRows.length || saved.finalOutput?.structuredContent?.departmentCount !== actualRows.length || saved.runtimeApproval)
        throw new Error("Local model-read evidence did not prove the expected read-only completion");
      const privateRun = await workspace.repository.read(state => state.executions[run.id]);
      if (privateRun.runtimeApprovalSecret || Object.values(privateRun.operationSecret.intents).some(intent => intent.evidenceMeaning === "operation-accepted"))
        throw new Error("Local read-only rehearsal unexpectedly contains effect authority");
      const replay = await request("POST", `/api/workflows/${draft.id}/run`, command, 202);
      if (replay.id !== run.id) throw new Error("Stable replay created a different run");
      console.log(`LOCAL Docker ${kind}: v8 synthetic draft generated and explicitly published; DONE; ${actualRows.length} actual synthetic rows; matching fixture departmentCount; ${saved.durationMs} ms whole-run sample; no effect or approval; replay returned the same run.`);
    }
    console.log("Product registry, existing workspace and ERPBridge source unchanged. Planning and token usage are synthetic fixtures, not real-provider or production acceptance.");
  } finally { await workspace.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); }
  catch { console.error("Synthetic Docker model-read qualification failed; no production qualification claimed. Credentials suppressed."); process.exitCode = 1; }
}

// Read-only qualification against the already-running isolated Docker bridge.
// No bridge files, configuration, resource definitions or business effects are changed.
import { createQaWorkspace, qaModelDecisionBlueprint } from "./erpbridge-workspace-qa.mjs";
import { parse } from "yaml";

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
  const provider = workspace.services.providerRuntime;
  provider.activate({ ...provider.configuration, egressPolicy: { ...provider.configuration.egressPolicy, runtimeAnalysisDataClasses: ["restricted"], runtimeAgentDataClasses: ["restricted"] } });
  for (const kind of ["analysis", "agent"]) for (const branch of ["then", "else"]) for (const selected of [true, false]) {
    const session = await request("POST", "/api/chat/sessions", {}, 201), beforePlanning = await workspace.repository.snapshot();
    const chat = await request("POST", `/api/chat/sessions/${session.id}/messages`, { content: `Create a local workflow to read synthetic Departments and conditionally count them with ${kind} on the Yes path.` });
    const draft = { id: chat.assistantMessage?.artifacts?.workflowId }, proposed = parse(chat.yaml);
    const afterPlanning = await workspace.repository.snapshot(), savedDraft = afterPlanning.workflows[draft.id];
    if (!savedDraft || savedDraft.publishedVersion !== 0 || chat.workflowDraft?.generation_metadata?.promptTemplateVersion !== "prompt/candidate/v16" ||
        chat.validation?.passed !== true || JSON.stringify(proposed.metadata.controlFlow) !== JSON.stringify(qaModelDecisionBlueprint(kind).metadata.controlFlow) ||
        !chat.answer.includes("has not been published or executed") || Object.keys(afterPlanning.executions).length !== Object.keys(beforePlanning.executions).length)
      throw new Error("Conditional chat proposal was not preserved as an unpublished unexecuted draft");
    const reopened = await request("GET", `/api/chat/sessions/${session.id}`);
    if (reopened.messages.at(-1)?.artifacts?.workflowId !== draft.id) throw new Error("Saved decision chat lost its workflow reference");
    // Exercise the real saved-draft edit API, not only generated fixture source:
    // remove the model, then put it directly into either empty path.
    const model = proposed.steps.find(step => step.id === "count");
    const base = await request("GET", `/api/workflows/${draft.id}/readiness`);
    const removed = await request("POST", `/api/workflows/${draft.id}/commands`, { baseVersion: base.version, baseHash: base.contentHash,
      command: { type: "removeNode", nodeId: "count" } });
    const edited = await request("POST", `/api/workflows/${draft.id}/commands`, { baseVersion: removed.version, baseHash: removed.contentHash,
      command: { type: kind === "analysis" ? "addAnalysis" : "addAgent", node: model, beforeNodeId: null, destination: { conditionId: "include_count", branch } } });
    const expectedFlow = structuredClone(proposed.metadata.controlFlow), gate = expectedFlow.root.nodes[1];
    gate.then.nodes = []; gate.else.nodes = []; gate[branch].nodes = [{ kind: "action", nodeId: "count" }];
    const afterEditing = await workspace.repository.snapshot();
    if (edited.validation?.passed !== true || edited.canRun !== false || JSON.stringify(parse(edited.yaml).metadata.controlFlow) !== JSON.stringify(expectedFlow) ||
        afterEditing.workflows[draft.id].publishedVersion !== 0 || Object.keys(afterEditing.executions).length !== Object.keys(beforePlanning.executions).length)
      throw new Error("Direct empty-branch model insertion was not preserved as a validated unexecuted draft");
    const published = await request("POST", `/api/workflows/${draft.id}/publish`, {});
    if (published.compiledOperation?.schemaVersion !== "workflow-operation-ir/v4") throw new Error("Decision IR was not separately versioned");
    const command = { mode: "async-operation", idempotencyKey: `docker-decision-${kind}-${branch}-${selected}-0001`, input: { includeCount: selected } };
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
    const modelSelected = selected === (branch === "then");
    if (modelSelected ? saved.stepOutputs?.count?.structuredContent?.departmentCount !== rows.length :
        saved.stepOutputs?.count !== undefined || saved.tokens?.total !== 0 || saved.readProgress?.attempts?.count?.status !== "SKIPPED")
      throw new Error("Model answer or explicit non-selected no-model evidence did not match");
    const before = await workspace.repository.snapshot();
    const replay = await request("POST", `/api/workflows/${draft.id}/run`, command, 202);
    const after = await workspace.repository.snapshot();
    if (replay.id !== run.id || JSON.stringify(before.executionEvents[run.id]) !== JSON.stringify(after.executionEvents[run.id])) throw new Error("Replay changed decision run evidence");
    console.log(`LOCAL Docker ${kind}/insert-${branch === "then" ? "Yes" : "No"}/select-${selected ? "Yes" : "No"}: v16 fixture chat saved/reopened; exact empty-branch model edit saved without execution; explicit publication/run; v4 decision DONE; 8 actual synthetic rows; ${modelSelected ? "bounded fixture answer matches" : "runtime model skipped with no answer or token usage"}; replay unchanged; no writes or email.`);
  }
} finally { await workspace.close(); }

// Explicit disposable qualification: normal HTTP handlers/worker plus actual
// Docker MCP, synthetic ERP data and an injected LOCAL model fixture only.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createQaWorkspace } from "./erpbridge-workspace-qa.mjs";
import { parse, stringify } from "yaml";

export async function main(args) {
  if (args.length !== 1 || args[0] !== "--run-reviewed-model-reads")
    throw new Error("Use the explicit synthetic model-read qualification flag");
  const workspace = await createQaWorkspace({ modelReadFixture: true });
  try {
    const login = await workspace.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: "qa@example.test", password: "Local-QA-only-2026!" },
    });
    if (login.statusCode !== 200)
      throw new Error("Local QA authentication failed");
    const headers = {
      authorization: `Bearer ${login.json().data.accessToken}`,
    };
    const request = async (method, url, payload, expected) => {
      const response = await workspace.app.inject({
        method,
        url,
        headers,
        ...(payload ? { payload } : {}),
      });
      if (response.statusCode !== expected)
        throw new Error(
          `Local model-read ${method} did not return its expected status`,
        );
      return response.json().data;
    };
    for (const dataClass of [
      "public",
      "internal",
      "confidential",
      "restricted",
    ]) {
      const discovery = await request(
        "POST",
        "/api/registry/capabilities/discovery",
        {},
        200,
      );
      const observation = discovery.observations.find(
        (value) => value.definition.name === "qa_list_departments",
      );
      if (!observation)
        throw new Error("Exact synthetic read observation missing");
      const reviewed = await request(
        "POST",
        `/api/registry/capabilities/${observation.capabilityId}/review`,
        {
          observationId: observation.id,
          contractHash: observation.contractHash,
          decisionKey: `synthetic-data-class-${dataClass}-0001`,
          effectClass: "read",
          riskClass: "low",
          dataClass,
          retryPolicy: "never",
          note: "Explicit disposable synthetic classification qualification; not business data review",
        },
        200,
      );
      if (reviewed.revision.policy.dataClass !== dataClass)
        throw new Error("Reviewed synthetic class did not match");
      // This is an explicitly synthetic in-process provider. No external model
      // is contacted and no default server or production policy is widened.
      const provider = workspace.services.providerRuntime;
      provider.activate({
        ...provider.configuration,
        egressPolicy: {
          ...provider.configuration.egressPolicy,
          runtimeAnalysisDataClasses: [dataClass],
          runtimeAgentDataClasses: [dataClass],
        },
      });
      for (const kind of ["analysis", "agent"]) {
        const candidate = await request(
          "POST",
          "/api/synthesis",
          {
            prompt: `Create a local workflow to read synthetic Departments and count them with ${kind}.`,
          },
          200,
        );
        if (
          !candidate.validation.passed ||
          candidate.execution_profile_issues.length ||
          candidate.candidate.generation_metadata.promptTemplateVersion !==
            "prompt/candidate/v9"
        )
          throw new Error(
            "Local synthesis did not prove the expected versioned draft",
          );
        // The local planning fixture consumes server-derived advisory hints;
        // normal publication still independently captures current authority.
        const blueprint = parse(candidate.yaml),
          modelNode = blueprint.steps.find((step) => step.kind === kind);
        if (!modelNode)
          throw new Error("Synthetic candidate model node missing");
        if (modelNode.data_class !== dataClass) throw new Error("Generated class did not match the server-derived source hint");
        if (dataClass !== "public") {
          modelNode.data_class = "public";
          const unsafe = await request(
            "POST",
            "/api/workflows",
            { yaml: stringify(blueprint) },
            201,
          );
          const countBefore = await workspace.repository.read(
            (state) => Object.keys(state.executions).length,
          );
          const denied = await workspace.app.inject({
            method: "POST",
            url: `/api/workflows/${unsafe.id}/publish`,
            headers,
            payload: {},
          });
          if (
            denied.statusCode !== 422 ||
            denied.json().meta?.code !== "MODEL_DATA_CLASS_DOWNGRADE" ||
            countBefore !==
              (await workspace.repository.read(
                (state) => Object.keys(state.executions).length,
              ))
          )
            throw new Error(
              "Underclassified synthetic publication was not denied",
            );
          console.log(
            `LOCAL Docker ${dataClass}/${kind}: public downgrade denied before run admission.`,
          );
          modelNode.data_class = dataClass;
        }
        const draft = await request(
          "POST",
          "/api/workflows",
          { yaml: stringify(blueprint) },
          201,
        );
        await request("POST", `/api/workflows/${draft.id}/publish`, {}, 200);
        const readiness = await request(
          "GET",
          `/api/workflows/${draft.id}/readiness`,
          null,
          200,
        );
        if (
          !readiness.can_attempt_run ||
          readiness.effectProfile !== "read-only"
        )
          throw new Error("Local model-read publication is not ready");
        const command = {
          mode: "async-operation",
          idempotencyKey: `explicit-model-read-${dataClass}-${kind}-0001`,
          input: {},
        };
        const run = await request(
            "POST",
            `/api/workflows/${draft.id}/run`,
            command,
            202,
          ),
          deadline = Date.now() + 15_000;
        let saved;
        do {
          saved = await request("GET", `/api/executions/${run.id}`, null, 200);
          if (!["PENDING", "RUNNING"].includes(saved.status)) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        } while (Date.now() < deadline);
        const actualRows =
          saved.stepOutputs?.departments?.structuredContent?.data;
        if (
          saved.status !== "DONE" ||
          !Array.isArray(actualRows) ||
          !actualRows.length ||
          saved.finalOutput?.structuredContent?.departmentCount !==
            actualRows.length ||
          saved.runtimeApproval
        ) {
          console.error("Synthetic completion diagnostics", { status: saved.status, failureCategory: saved.failure?.failureCategory, hasRows: Array.isArray(actualRows), hasFinal: Boolean(saved.finalOutput) });
          throw new Error(
            "Local model-read evidence did not prove the expected read-only completion",
          );
        }
        const privateRun = await workspace.repository.read(
          (state) => state.executions[run.id],
        );
        if (privateRun.tokens.total !== (kind === "agent" ? 4 : 2)) throw new Error("Private fixture usage did not match the acknowledged model rounds");
        if (
          privateRun.runtimeApprovalSecret ||
          Object.values(privateRun.operationSecret.intents).some(
            (intent) => intent.evidenceMeaning === "operation-accepted",
          )
        )
          throw new Error(
            "Local read-only rehearsal unexpectedly contains effect authority",
          );
        const events = await workspace.repository.read(state => state.executionEvents[run.id]);
        if (kind === "agent") {
          const completed = events.find(event => event.type === "node.agent_completed");
          const intents = Object.values(privateRun.operationSecret.intents);
          if (completed?.payload?.rounds !== 2 || completed.payload.toolCalls !== 1 ||
              intents.filter(intent => intent.dispatchKind === "agent-model" && intent.state === "ACKNOWLEDGED").length !== 2 ||
              intents.filter(intent => intent.dispatchKind === "agent-tool" && intent.state === "ACKNOWLEDGED" && intent.evidenceMeaning === "agent-tool-result").length !== 1)
            throw new Error("Synthetic agent did not prove two model rounds and one governed Docker tool call");
        }
        const replay = await request(
          "POST",
          `/api/workflows/${draft.id}/run`,
          command,
          202,
        );
        if (replay.id !== run.id)
          throw new Error("Stable replay created a different run");
        if (JSON.stringify(await workspace.repository.read(state => state.executionEvents[run.id])) !== JSON.stringify(events)) throw new Error("Replay unexpectedly added execution events");
        console.log(
          `LOCAL Docker ${dataClass}/${kind}: v9 fixture draft follows reviewed source hint; published; DONE; ${actualRows.length} actual synthetic rows; matching fixture departmentCount; ${kind === "agent" ? "two model rounds and one dynamic governed Docker read; " : ""}${saved.durationMs} ms whole-run sample; no effect or approval; replay returned the same run without new events.`,
        );
      }
    }
    console.log(
      "Product registry, existing workspace and ERPBridge source unchanged. Planning and token usage are synthetic fixtures, not real-provider or production acceptance.",
    );
  } finally {
    await workspace.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    await main(process.argv.slice(2));
  } catch {
    console.error(
      "Synthetic Docker model-read qualification failed; no production qualification claimed. Credentials suppressed.",
    );
    process.exitCode = 1;
  }
}

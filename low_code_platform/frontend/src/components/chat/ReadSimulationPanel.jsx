import { useRef, useState } from "react";
import { workflowService } from "../../services/workflow.service";
import ValueFields from "./ValueFields";
import SchemaFields from "./SchemaFields";
import ReadableValue, { ReadableResult } from "./ReadableValue";
import { collectionOwners, IterationFixturePicker } from "./CollectionFields";
import { flowProtectedGroups } from "./protectedFlow";
import { protectedSimulationLabels, simulationFixturePayload, protectedSimulationBoundary, validProtectedTraceEntry } from "./protectedSimulation";

const button = "rounded-md px-3 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/10 disabled:opacity-40 disabled:cursor-not-allowed";
const outcomes = { SIMULATED: "Supplied response accepted", SIMULATED_DECISION: "Condition evaluated", SIMULATED_VALUE: "Typed value evaluated", NOT_SELECTED: "Other path · not evaluated", AFTER_RETURN: "After return · not evaluated", MISSING_FIXTURE: "No test response supplied", FIXTURE_TOOL_ERROR: "Supplied tool error", FIXTURE_OUTPUT_INVALID: "Invalid test response", ARGUMENTS_INVALID: "Arguments do not match the tool schema", BINDING_UNAVAILABLE_OR_LIMITED: "Required data missing or too large", PREDICATE_INVALID: "Condition requires Yes or No", VALUE_INVALID: "Value does not match its declared type", WORKFLOW_INPUT_INVALID: "Inputs do not match the workflow schema", SELECTED_PATH_RULE_BLOCKED: "Selected path violates a local rule", SIMULATION_OUTPUT_LIMIT: "Simulation display budget exceeded", SIMULATION_EVALUATION_FAILED: "Simulation could not continue" };
const message = cause => cause?.response?.data?.message || cause?.message || "Simulation could not be completed. No automatic retry was sent.";
const verifierIssue = code => ({ YAML_PARSE_ERROR: "Draft source could not be parsed", SCHEMA_INVALID: "Draft structure is invalid", SCHEMA_DESCRIPTION_REQUIRED: "Workflow description is required", LOCAL_VERIFIER_REJECTED: "A local rule rejected this draft" })[code] || "A local verifier check failed. Review the draft validation details.";
const collectionOutcomes = { SIMULATED_COLLECTION_STARTED: "Collection input checked", EMPTY_COLLECTION: "Empty collection · body not evaluated", COLLECTION_INPUT_INVALID: "Collection requires present, correctly typed list data", COLLECTION_LIMIT_EXCEEDED: "Collection exceeds its declared item limit", COLLECTION_VISIT_LIMIT: "Collection evaluation budget exceeded" };
const outcomeLabel = code => protectedSimulationLabels[code] || outcomes[code] || collectionOutcomes[code] || "Simulation could not continue";
const modelOutcomes = { SUPPLIED_MODEL_OUTPUT: "Supplied structured model answer accepted", MODEL_INPUT_LIMIT_EXCEEDED: "Combined model input exceeds the declared limit", FIXTURE_AGENT_INCOMPLETE: "Supplied agent answer does not meet its completion predicate" };
const modelNode = step => ["analysis", "agent"].includes(step.kind ?? step.source?.kind);
function validResponse(value, workflowId, record, hasLoops, hasModels, hasProtected) {
  const profile = hasProtected ? "fixture-protected/v1" : hasModels ? "fixture-model/v1" : hasLoops ? "fixture-read/v2" : "fixture-read/v1";
  const modelBoundary = !(hasModels || hasProtected) || value?.model_behavior === "not_tested" && value.model_usage === "not_measured" && value.agent_tool_calls === "not_simulated" && value.approval === "not_granted" && !Object.hasOwn(value, "tokens");
  const kinds = ["action", "condition", "merge", "return", ...(hasModels ? ["analysis", "agent"] : []), ...(hasLoops ? ["collection", "collection-item"] : []), ...(hasProtected ? ["protect"] : [])];
  return value?.simulation === profile && modelBoundary && (!hasProtected || protectedSimulationBoundary(value)) &&
    value.dry_run === true && value.can_execute === false && value.erp_calls === 0 && value.model_calls === 0 && value.persisted_run === false &&
    value.live_readiness === "not_checked" && value.runtime_authorization === "not_checked" && value.capability_admission === "not_checked" && !value.id &&
    value.workflowId === workflowId && value.baseVersion === record.version && value.baseHash === record.contentHash &&
    (!record.authoring?.registryHash || value.registryHash === record.authoring.registryHash) &&
    ["PLAN_BLOCKED", "SIMULATED_COMPLETE", "SIMULATED_STOPPED"].includes(value.outcome) && Array.isArray(value.trace) && value.trace.length <= (hasLoops || hasProtected ? 5000 : 400) &&
    value.trace.every(entry => entry && kinds.includes(entry.kind) &&
      (Object.hasOwn(outcomes, entry.outcome) || hasModels && Object.hasOwn(modelOutcomes, entry.outcome) || hasLoops && Object.hasOwn(collectionOutcomes, entry.outcome) || hasProtected && Object.hasOwn(protectedSimulationLabels, entry.outcome)) &&
      (!hasProtected || validProtectedTraceEntry(entry, record)) &&
      (!(hasLoops || hasProtected) || Array.isArray(entry.iterations) && entry.iterations.length <= 8 &&
        entry.iterations.every(frame => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(frame.loopId) && Number.isInteger(frame.index) && frame.index >= 0 && frame.index < 100) &&
        entry.invocationId === [...entry.iterations.flatMap(frame => [frame.loopId, String(frame.index)]), entry.nodeId].join("/")));
}

function SimulationWorkspace({ workflowId, record, steps, canControl, disabled }) {
  const [input, setInput] = useState({}), [fixtures, setFixtures] = useState({}), [result, setResult] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const authoring = record.authoring?.profile === "read-authoring/v1" ? record.authoring : null;
  const owners = collectionOwners(authoring?.controlFlow), hasLoops = [...owners.values()].some(loops => loops.length) || authoring?.executionProfile === "collection-simulation-only";
  const hasModels = steps.some(modelNode);
  const hasProtected = authoring?.protectedSimulationProfile === "protected-fixtures/v1";
  const rows = steps.slice(0, 200).flatMap(step => owners.get(step.id)?.length ? Object.keys(fixtures).filter(address => address.split("/").at(-1) === step.id).map(address => ({ ...step, id: address, nodeId: step.id })) : [{ ...step, nodeId: step.id }]);
  const update = (nodeId, next) => { setFixtures(old => ({ ...old, [nodeId]: next })); setResult(null); setError(""); };
  const changeInput = next => { setInput(next); setResult(null); setError(""); };
  const simulate = async () => {
    if (pending.current || !canControl || disabled) return;
    pending.current = true; setBusy(true); setResult(null); setError("");
    const { outputs, failures } = simulationFixturePayload(fixtures, steps);
    try {
      const value = await workflowService.simulate(workflowId, record, input, outputs, ...(hasProtected ? ["protected-fixtures/v1", failures] : hasModels ? ["model-fixtures/v1"] : hasLoops ? ["read-fixtures/v2"] : []));
      if (!validResponse(value, workflowId, record, hasLoops, hasModels, hasProtected)) throw new Error("Simulation response could not be verified. It is not shown as execution evidence.");
      setResult(value);
    } catch (cause) { setError(message(cause)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <details className="mt-6 border-t border-gray-200 pt-4 text-xs dark:border-gray-700">
    <summary className="cursor-pointer font-medium">Simulate draft with test data</summary>
    <p className="mt-2 text-gray-500">Supplied responses only. No ERP or model calls, saved run, approval or live readiness check.</p>
    {hasModels && <p className="mt-2 text-gray-500">Model answers are supplied test fields, not inference. This checks input bounds, output types and agent completion only; model accuracy, usage, dynamic agent reads and effect approvals are not tested.</p>}
    {hasProtected && <p className="mt-2 text-gray-500">Protected paths use explicitly supplied business read faults only. These are not ERP errors or proof that a record is absent. Supplied effect responses grant no approval and send nothing. Generic tool errors stop; they do not enter a handler.</p>}
    {!canControl ? <p className="mt-3 text-gray-500">Workflow run permission is required for simulation.</p> : <>
      <fieldset disabled={busy || disabled} className="mt-4 space-y-4">
        <legend className="mb-3 font-medium">Simulation inputs</legend>
        {authoring?.inputSchema ? <SchemaFields label="Simulation inputs" schema={authoring.inputSchema} value={input} onChange={changeInput} allowReferences={false} /> : <ValueFields label="Simulation inputs" value={input} onChange={changeInput} />}
        <h4 className="border-t pt-4 font-medium">Supplied node responses</h4>
        <p className="text-gray-500">Enable responses explicitly. An unsupplied selected node stops the simulation; unused paths need no response. Use test data, not credentials.</p>
        {hasLoops && <p className="text-gray-500">Collection profile · simulation only. Every selected item needs its own response; one node response is never reused for all items.</p>}
        {steps.filter(step => owners.get(step.id)?.length).map(step => <IterationFixturePicker key={step.id} nodeId={step.id} loops={owners.get(step.id)} fixtures={fixtures} onAdd={address => update(address, { enabled: true, structured: false, fields: {}, text: "", failure: false })} />)}
        {rows.map(step => {
          const value = fixtures[step.id] || { enabled: false, structured: false, fields: {}, text: "", failure: false }, guide = authoring?.nodes?.find(node => node.nodeId === step.nodeId);
          const isModel = modelNode(step), schema = isModel ? step.output_schema ?? step.source?.output_schema ?? guide?.outputSchema : guide?.outputSchema;
          return <details key={step.id} className="border-b border-gray-100 pb-3 dark:border-gray-800"><summary className="cursor-pointer py-1">{step.id} · {value.enabled ? "Test response supplied" : "Not supplied"}</summary><div className="mt-3 space-y-3">
            <label className="flex items-center gap-2"><input type="checkbox" aria-label={`Supply response for ${step.id}`} checked={value.enabled} onChange={event => update(step.id, { ...value, enabled: event.target.checked })} />Supply a test response</label>
            {value.enabled && <>
              {hasProtected && !isModel && <label className="block text-gray-500">Test response type<select aria-label={`${step.id} test response type`} value={value.businessFault ? "business" : value.failure ? "tool-error" : "success"} onChange={event => update(step.id, { ...value, businessFault: event.target.value === "business", failure: event.target.value === "tool-error" })} className="mt-1 w-full rounded-md border border-gray-200 bg-transparent px-3 py-2 dark:border-gray-700"><option value="success">Successful supplied response</option><option value="tool-error">Generic tool error · stop</option>{guide?.simulatedBusinessReadErrorCodes?.includes("ERP_RESOURCE_NOT_FOUND") && <option value="business">Business read fault · test handler</option>}</select></label>}
              {!value.businessFault && <>
              {!isModel && <label className="flex items-center gap-2"><input type="checkbox" aria-label={`${step.id} structured test data`} checked={value.structured} onChange={event => update(step.id, { ...value, structured: event.target.checked })} />Structured response fields</label>}
              {(isModel || value.structured) && (schema?.type === "object" ? <SchemaFields label={`${step.id} test output`} schema={schema} value={value.fields} onChange={fields => update(step.id, { ...value, fields })} allowReferences={false} /> : <ValueFields label={`${step.id} test output`} value={value.fields} onChange={fields => update(step.id, { ...value, fields })} />)}
              {!isModel && <><label className="block text-gray-500">Response text<textarea aria-label={`${step.id} test response text`} value={value.text} maxLength={200000} onChange={event => update(step.id, { ...value, text: event.target.value })} className="mt-1 min-h-20 w-full rounded-md border border-gray-200 bg-transparent px-3 py-2 outline-none focus:border-primary dark:border-gray-700" /></label>
              {!hasProtected && <label className="flex items-center gap-2"><input type="checkbox" aria-label={`${step.id} test tool error`} checked={value.failure} onChange={event => update(step.id, { ...value, failure: event.target.checked })} />Simulate a tool-reported error</label>}</>}
              </>}
            </>}
          </div></details>;
        })}
      </fieldset>
      <button type="button" className={`${button} mt-3`} disabled={busy || disabled} onClick={simulate}>{busy ? "Evaluating test data…" : "Evaluate simulation"}</button>
      {disabled && <p className="mt-2 text-gray-500">Reload a verified saved draft before simulating.</p>}
    </>}
    {error && <p role="alert" className="mt-3 text-red-600">{error}</p>}
    {result && canControl && !disabled && <section aria-label="Simulation results" className="workspace-reveal mt-5 border-t border-gray-200 pt-4 dark:border-gray-700">
      <h4 className="font-medium">{result.outcome === "SIMULATED_COMPLETE" ? "Simulation complete" : result.outcome === "PLAN_BLOCKED" ? "Draft cannot be simulated" : "Simulation stopped"} · draft v{result.baseVersion}</h4>
      <p className="mt-1 text-gray-500">Test data · not a real execution receipt. {result.reason && (modelOutcomes[result.reason] || outcomeLabel(result.reason))}</p>
      {result.issues?.length > 0 && <ul className="mt-3 list-disc pl-4">{result.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}
      {result.validation?.errors?.length > 0 && <ul className="mt-3 list-disc pl-4">{result.validation.errors.slice(0, 50).map((code, index) => <li key={index}>{verifierIssue(code)}</li>)}</ul>}
      <ol className="mt-4 space-y-3">{result.trace.slice(0, 500).map((entry, index) => <li key={index} className="border-l border-gray-200 pl-3 dark:border-gray-700">
        <p className="font-medium">{entry.nodeId} · {modelOutcomes[entry.outcome] || outcomeLabel(entry.outcome)}</p>
        {hasProtected && entry.reason && <p className="text-gray-500">{outcomeLabel(entry.reason)}</p>}
        {entry.iterations?.length > 0 && <p className="text-gray-500">{entry.iterations.map(frame => `${frame.loopId} · item ${frame.index + 1}`).join(" / ")}</p>}
        {Number.isInteger(entry.count) && <p className="text-gray-500">{entry.count} supplied items</p>}
        {entry.selectedBranch && <p className="mt-1 text-gray-500">{entry.selectedBranch === "then" ? "If yes" : "If no"}</p>}
        {entry.returnId && <p className="mt-1 text-gray-500">Stopped by return · {entry.returnId}</p>}
        {Object.hasOwn(entry, "arguments") && <details className="mt-2"><summary className="cursor-pointer text-gray-500">{["analysis", "agent"].includes(entry.kind) ? "Evaluated model input" : "Evaluated arguments"}</summary><ReadableValue value={entry.arguments} /></details>}
        {Object.hasOwn(entry, "output") && <details className="mt-2"><summary className="cursor-pointer text-gray-500">{entry.kind === "action" ? "Supplied response" : "Simulated value"}</summary>{entry.output === null ? <p>Explicit null</p> : <ReadableResult value={entry.output} />}</details>}
      </li>)}</ol>
      {result.trace.length > 500 && <p className="mt-3 text-gray-500">Showing the first 500 simulation events. Final status and collected value apply to the whole bounded evaluation.</p>}
      {Object.hasOwn(result, "finalOutput") && <div className="mt-4 border-t pt-3"><p className="mb-2 font-medium">{result.outcome === "SIMULATED_COMPLETE" ? "Simulated final value" : "Last accepted simulated value · incomplete"}</p>{result.finalOutput === null ? <p>Explicit null</p> : <ReadableResult value={result.finalOutput} />}</div>}
      {result.unusedFixtureIds?.length > 0 && <p className="mt-3 text-gray-500">Unused supplied responses · {result.unusedFixtureIds.join(", ")}</p>}
    </section>}
  </details>;
}

// Remount on revision changes: stale results/fixtures never become evidence
// for a different draft, and test data is not stored in session/local storage.
export default function ReadSimulationPanel(props) {
  const protectedDraft = flowProtectedGroups(props.record.authoring?.controlFlow).length || ["protected-operation-v1", "protected-draft-runtime-pending"].includes(props.record.executionProfile);
  if (protectedDraft && (props.record.authoring?.profile !== "read-authoring/v1" || props.record.authoring?.protectedSimulationProfile !== "protected-fixtures/v1")) return <details className="mt-6 border-t border-gray-200 pt-4 text-xs dark:border-gray-700"><summary className="cursor-pointer font-medium">Simulate draft with test data</summary><p className="mt-2 text-gray-500">Protected simulation guidance is unavailable from this backend. No simulation, ERP call or model call is sent from this panel. Reload after upgrading the backend.</p></details>;
  return <SimulationWorkspace key={`${props.workflowId}:${props.record.version}:${props.record.contentHash}:${props.record.authoring?.registryHash}:${props.record.authoring?.protectedSimulationProfile}:${props.canControl}:${Boolean(props.disabled)}`} {...props} />;
}

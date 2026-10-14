import { stringify } from "yaml";
import { ProtectedMachine, protectedMachinePlan } from "../../src/workflows/protected-machine.js";
import { ProtectedInvocationLedger } from "../../src/runner/protected-invocation-ledger.js";
import { compileProtectedFixtureWorkflow } from "../../src/workflows/compiled-read.js";
import { protectedJournalHash as hash } from "../../src/repository/protected-invocation-records.js";
import { capabilityContractHash } from "../../src/registry/capability-admission.js";
import { protectedSimulationSource as source, protectedSimulationRead as read, protectedSimulationRole as role,
  fixtureSequence as seq, fixtureRef as ref } from "./protected-simulation.js";

/** Synthetic DATA only. No admitted operation IR, genuine SDK failure,
 * broker call, approval, live model or effect is established here. */
export function protectedInvocationFixture(items = ["A", "B"], executionId = "run") {
  const src = source(), group = src.metadata.controlFlow.root.nodes[0]; src.steps.pop(); src.steps[0].parameters.id = "{{each.item}}";
  src.metadata.controlFlow.root = seq({ kind: "foreach", id: "each", maxItems: 3,
    items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "workflowInput", path: ["items"] } },
    body: seq(group), collect: { schema: { type: "string" }, value: ref("guard", "value") } },
    { kind: "return", id: "answer", output: { schema: { type: "array", items: { type: "string" } }, value: ref("each", "value") } });
  src.trigger.config = { inputSchema: { type: "object", properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"], additionalProperties: false } };
  const compiled = compileProtectedFixtureWorkflow(stringify(src), [read], role);
  const plan = protectedMachinePlan(compiled.sourceHash, compiled.flow, compiled.nodes.map(node => ({ id: node.id, input: node.kind === "action" ? node.inputs : node.input })), compiled.inputSchema);
  const input = { items }, machine = new ProtectedMachine(plan, input); machine.peek();
  const identity = { executionId, workflowId: "flow", actorId: "owner", roleId: "role_admin", admittedRole: role, sourceHash: plan.sourceHash,
    operationHash: hash({ profile: "synthetic-operation-identity/v1", sourceHash: compiled.sourceHash, nodes: compiled.nodes }), machineHash: plan.semanticHash, inputHash: hash(input) };
  return { plan, input, machine, identity, ledger: new ProtectedInvocationLedger(identity, plan, machine) };
}
export const protectedInvocationFixtureFailure = () => ({ profile: "reviewed-read-business-failure/v1" as const, code: "ERP_RESOURCE_NOT_FOUND" as const,
  toolId: read.tool_id, contractHash: capabilityContractHash(read), admissionPin: { connectionId: "fixture-connection", capabilityId: "fixture-capability",
    revisionId: "fixture-revision", admissionVersion: 1, contractHash: capabilityContractHash(read) } });

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import os from "node:os";
import { stringify } from "yaml";
import { canonicalJSONBytes } from "../src/core/canonical-json.js";
import { toolSchema } from "../src/registry/schemas.js";
import { capabilityContractHash } from "../src/registry/capability-admission.js";
import { compileProtectedOperationWorkflow, assertProtectedOperationPlanCurrent } from "../src/workflows/protected-operation-compiler.js";
import { compileOperationWorkflow } from "../src/workflows/compiled-read.js";
import { ProtectedMachine } from "../src/workflows/protected-machine.js";
import { evaluateLatencyBudget } from "../src/performance/latency-report.js";

// Pure synthetic DATA only. No environment credentials, repository, transport,
// provider, SDK, approval or worker is instantiated by this measurement.
const role = "Platform Admin", items = Array.from({ length: 10 }, (_, index) => `item-${index}`);
const tool = toolSchema.parse({ tool_id: "PROTECTED-COMPILER-LATENCY", name: "fixture.protected-read", mcp_tool_name: "fixture.protected-read",
  allowed_roles: [role], is_read_only: true, risk_level: "low",
  input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  bridge_contract: { profile: "toolplane-v1", resource_version: "1.0.0", resource_digest: "a".repeat(64), remote_roles: [],
    output_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } },
  read_error_contract: { profile: "erpbridge-read-error/v1", remote_type: "not_found", business_error: "ERP_RESOURCE_NOT_FOUND" } });
const tools = Array.from({ length: 100 }, (_, index) => toolSchema.parse({ ...tool, tool_id: `${tool.tool_id}-${index}`,
  name: `${tool.name}-${index}`, mcp_tool_name: `${tool.mcp_tool_name}-${index}` }));
const pins = new Map(tools.map((definition, index) => [definition.tool_id, { connectionId: "erp", capabilityId: `synthetic-capability-${index}`,
  revisionId: `synthetic-revision-${index}`, admissionVersion: 1, contractHash: capabilityContractHash(definition) }])), classification = () => "internal";
const sequence = (...nodes) => ({ kind: "sequence", nodes });
const action = nodeId => ({ kind: "action", nodeId });
const ref = (nodeId, ...path) => ({ kind: "ref", source: "nodeOutput", nodeId, path });
const originalIDs = Array.from({ length: 99 }, (_, index) => `node_${index}`);
const yaml = stringify({ name: "100-node protected compiler latency DATA", description: "No live calls or execution authority", trigger: { type: "manual", config: {
  inputSchema: { type: "object", properties: { items: { type: "array", maxItems: 10, items: { type: "string" } } }, required: ["items"], additionalProperties: false } } },
  steps: [...originalIDs, "fallback"].map((id, index) => ({ id, action: tools[index].name, parameters: { id: id === "fallback" ? "{{guard.error.code}}" : "{{each.item}}" } })),
  metadata: { controlFlow: { schemaVersion: "read-control-flow/v4", root: sequence({ kind: "foreach", id: "each", maxItems: 10,
    items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "ref", source: "workflowInput", path: ["items"] } },
    body: sequence({ kind: "protect", id: "guard", onError: { code: "ERP_RESOURCE_NOT_FOUND" }, body: sequence(...originalIDs.map(action)), handler: sequence(action("fallback")),
      output: { schema: { type: "string" }, success: ref(originalIDs.at(-1), "structuredContent", "text"), handled: ref("fallback", "structuredContent", "text") } }),
    collect: { schema: { type: "string" }, value: ref("guard", "value") } },
  { kind: "return", id: "answer", output: { schema: { type: "array", items: { type: "string" } }, value: ref("each", "value") } }) } } });
const compile = () => compileProtectedOperationWorkflow(yaml, tools, role, pins, classification);
const plan = compile(); assert.equal(plan.ir.root.nodes.length, 100); assert.equal(Object.keys(plan.ir.contracts).length, 100);
assert.equal(plan.ir.capabilityClasses.length, 100);
assert.throws(() => compileOperationWorkflow(yaml, tools, role, pins), /durable operation iteration/);
const measure = callback => {
  for (let index = 0; index < 5; index++) callback();
  return Array.from({ length: 50 }, () => { const started = performance.now(); callback(); return performance.now() - started; });
};
const budgets = [evaluateLatencyBudget("pure-protected-100-node-compile", 50, measure(compile)),
  evaluateLatencyBudget("pure-protected-100-node-full-revalidation", 50, measure(() => assertProtectedOperationPlanCurrent(plan, yaml, tools, role, pins, classification)))];

function restoreEveryBoundary(handled) {
  let machine = new ProtectedMachine(plan.machine, { items });
  let boundaries = 0, suppliedOutputs = 0, suppliedFaults = 0;
  const started = performance.now();
  for (;;) {
    const point = machine.peek(); if (!point) break;
    assert.equal(point.valid, true); assert.ok(++boundaries <= 5000);
    const restored = new ProtectedMachine(plan.machine, {}, machine.snapshot());
    assert.ok(canonicalJSONBytes(restored.peek()).equals(canonicalJSONBytes(point)));
    machine = restored;
    if (point.kind === "action") {
      if (handled && point.nodeId === "node_0" && point.iterations[0].index % 2 === 1) {
        machine.fail({ code: "ERP_RESOURCE_NOT_FOUND", failedNodeId: point.nodeId, failedInvocationId: point.invocationId }); suppliedFaults++;
      } else {
        const text = point.nodeId === "fallback" ? `handled-${items[point.iterations[0].index]}` : point.arguments.id;
        machine.accept({ content: [], structuredContent: { text } }); suppliedOutputs++;
      }
    } else if (["merge", "return", "collection-item"].includes(point.kind) || point.kind === "collection-complete" && point.outcome !== "FAILED" ||
      point.kind === "protected-complete" && ["SUCCEEDED", "HANDLED_ERROR"].includes(point.outcome)) machine.accept({ value: point.value });
    else machine.accept();
  }
  const final = machine.snapshot(); assert.equal(final.status, "DONE");
  assert.deepEqual(final.result, { value: items.map((item, index) => handled && index % 2 === 1 ? `handled-${item}` : item) });
  assert.equal(suppliedFaults, handled ? 5 : 0); assert.equal(suppliedOutputs, handled ? 500 : 990);
  return { mode: handled ? "mixed-supplied-business-fault-DATA" : "success-supplied-output-DATA", boundaries, suppliedOutputs, suppliedFaults,
    restoreEveryBoundaryMs: Math.round((performance.now() - started) * 1000) / 1000 };
}
const continuations = [restoreEveryBoundary(false), restoreEveryBoundary(true)];
console.log(JSON.stringify({ scope: "PURE DATA ONLY; not publication, durable worker, genuine failure or live ERP/model/streaming latency",
  recordedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length },
  workload: { originalNodes: 100, distinctSyntheticCapabilities: 100, maxItems: 10, warmups: 5, samples: 50, concurrentLanes: 1 },
  budgetScope: "50ms p95 local structural compile/full-revalidation target from corrected plan section 19.3; single-lane CPU only, not ten-user load, end-to-end or restoration qualification", budgets, continuations }, null, 2));
if (budgets.some(budget => !budget.passed)) process.exitCode = 1;

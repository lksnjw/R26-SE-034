import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { loadConfig } from "../src/config/config.js";
import { handleSynthesisCanvasRoute } from "../src/http/handlers/synthesis-canvas.js";
import { HandlerFailure, type CurrentUser, type HandlerServices } from "../src/http/handlers/common.js";
import type { RouteDefinition } from "../src/http/generated-routes.js";
import { parseWorkflowYAMLStrict } from "../src/parser/workflow.js";
import { RegistryService } from "../src/registry/service.js";
import { Repository } from "../src/repository/store.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { CanvasConversionFailure, canvasStepErrors, convertSourceOrderCanvas } from "../src/workflows/canvas-source-order.js";

const base = {
  profile: "source-order-canvas/v1" as const,
  name: "Canvas report",
  description: "Validates an explicit source-order graph.",
  trigger: { type: "manual" },
  metadata: { unresolved_requirements: [] },
  nodes: [
    { id: "second", action: "demo.echo", parameters: { value: "{{first.structuredContent.value}}" } },
    { id: "first", action: "demo.echo", parameters: { value: "hello" } },
  ],
  edges: [{ source: "first", target: "second" }],
};

describe("source-order canvas conversion", () => {
  test("orders semantic nodes from explicit edges and preserves typed step fields", () => {
    const converted = convertSourceOrderCanvas(base);
    expect(converted.nodeOrder).toEqual(["first", "second"]);
    expect(parseWorkflowYAMLStrict(converted.yaml)).toEqual({
      name: base.name, description: base.description, trigger: base.trigger, metadata: base.metadata,
      steps: [base.nodes[1], base.nodes[0]],
    });
  });

  test.each([
    { name: "branch", value: { ...base, nodes: [...base.nodes, { id: "third", action: "demo.echo", parameters: { value: "third" } }], edges: [{ source: "first", target: "second" }, { source: "first", target: "third" }] } },
    { name: "cycle", value: { ...base, edges: [{ source: "first", target: "second" }, { source: "second", target: "first" }] } },
    { name: "disconnected", value: { ...base, edges: [] } },
    { name: "unknown node", value: { ...base, edges: [{ source: "first", target: "missing" }] } },
    { name: "duplicate node", value: { ...base, nodes: [base.nodes[0], base.nodes[0]], edges: [{ source: "second", target: "second" }] } },
  ])("rejects $name without flattening or guessing", ({ value }) => {
    expect(() => convertSourceOrderCanvas(value)).toThrow(CanvasConversionFailure);
  });

  test("rejects UI decoration and unknown fields at the semantic boundary", () => {
    expect(() => convertSourceOrderCanvas({ ...base, nodes: [{ ...base.nodes[0], position: { x: 1, y: 2 } }, base.nodes[1]] })).toThrow(/Unrecognized key/);
  });

  test("correlates exact node/action tokens while leaving unrelated messages global", () => {
    expect(canvasStepErrors([{ id: "a", action: "demo.echo", parameters: {} }], [
      "Step a uses demo.echo incorrectly", "database policy unavailable",
    ])).toEqual([
      { scope: "node", node_id: "a", action: "demo.echo", message: "Step a uses demo.echo incorrectly" },
      { scope: "workflow", node_id: null, action: null, message: "database policy unavailable" },
    ]);
  });
});

test("canvas validation endpoint compiles node/edge input through the full registry gate without workflow or execution mutation", async () => {
  const repository = new Repository(null);
  const registries = await RegistryService.load(resolve("tests/fixtures/chat-read-tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, repository);
  const services = { config: loadConfig({ APP_ENV: "test", MCP_MODE: "mock" }), repository, registries, validator,
    executor: new Executor(new ToolRegistry(), validator) } satisfies HandlerServices;
  const user: CurrentUser = { id: "admin", name: "Admin", email: "admin@example.test", roleId: "platform-admin", permissionOverrides: [], status: "active", initials: "A",
    departmentId: null, lastLoginAt: null, createdAt: new Date(0).toISOString(), role: "Platform Admin", permissions: ["workflow:read"] };
  let response: unknown;
  const reply = { send(value: unknown) { response = value; return value; } } as FastifyReply;
  const route = { method: "POST", path: "/api/canvas/validate-workflow" } as RouteDefinition;
  await handleSynthesisCanvasRoute(route, { body: base } as FastifyRequest, reply, user, services);
  expect(response).toMatchObject({ success: true, data: { validation: { passed: true }, step_errors: [], conversion: {
    profile: "source-order-canvas/v1", node_order: ["first", "second"], source_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
  } } });
  await handleSynthesisCanvasRoute(route, { body: { ...base, metadata: { controlFlow: { schemaVersion: "read-control-flow/v1", root: { kind: "sequence", nodes: [{ kind: "action", nodeId: "missing" }] } } } } } as FastifyRequest, reply, user, services);
  expect(response).toMatchObject({ success: true, data: { validation: { passed: false, failed_rules: expect.arrayContaining(["WORKSPACE_READ_COMPILATION"]) } } });
  const state = await repository.snapshot();
  expect(state.workflows).toEqual({}); expect(state.executions).toEqual({});
});

test("canvas validation endpoint rejects ambiguous YAML plus graph input before the gate", async () => {
  const request = { body: { ...base, yaml: "name: ambiguous" } } as FastifyRequest;
  const minimal = { config: loadConfig({ APP_ENV: "test" }) } as HandlerServices;
  const error = await handleSynthesisCanvasRoute({ method: "POST", path: "/api/canvas/validate-workflow" } as RouteDefinition,
    request, { send: (value: unknown) => value } as FastifyReply, {} as CurrentUser, minimal).catch(caught => caught);
  expect(error).toBeInstanceOf(HandlerFailure); expect(error).toMatchObject({ status: 400 });
});

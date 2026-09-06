import { resolve } from "node:path";
import { expect, test } from "vitest";
import { stringify } from "yaml";
import { RegistryService } from "../src/registry/service.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { Repository } from "../src/repository/store.js";
import { validateWorkspaceDraft } from "../src/workflows/draft-validation.js";

const registries = await RegistryService.load(resolve("tests/fixtures/chat-read-tools.json"), resolve("tests/fixtures/rules.json"));
const validator = new RegistryValidator(registries, new Repository(null));
const seq = (...nodes: any[]) => ({ kind: "sequence", nodes });
function source(): any {
  return { name: "Read list", description: "Read an explicit list", trigger: { type: "manual" }, steps: [{ id: "read", action: "demo.echo", parameters: { value: "{{each.item}}" } }],
    metadata: { controlFlow: { schemaVersion: "read-control-flow/v3", root: seq({ kind: "foreach", id: "each", maxItems: 3,
      items: { schema: { type: "array", items: { type: "string" } }, value: { kind: "array", items: [{ kind: "literal", value: "fixture" }] } },
      body: seq({ kind: "action", nodeId: "read" }), collect: { schema: { type: "string" }, value: { kind: "ref", source: "nodeOutput", nodeId: "each", path: ["item"] } } }) } } };
}
const validate = (value: any) => validateWorkspaceDraft("Draft", stringify(value), "Platform Admin", validator, registries.snapshot().tools);

test("valid structural draft receives pure compiler evidence but no execution authority", () => {
  const result = validate(source());
  expect(result.passed).toBe(true); expect(result.score).toBe(1);
  expect(result.metadata.workspace_compilation).toEqual({ profile: "workspace-read-compilation/v1", issues: [] });
});

test.each(["self-input", "body-input", "future-result", "item-type", "literal-type", "expanded-budget", "malformed-flow"])("structural draft %s cannot receive a passing preview", damage => {
  const value = source(), loop = value.metadata.controlFlow.root.nodes[0];
  if (damage === "self-input") loop.items.value = { kind: "ref", source: "nodeOutput", nodeId: "each", path: ["value"] };
  if (damage === "body-input") loop.items.value = { kind: "ref", source: "nodeOutput", nodeId: "read", path: ["structuredContent", "value"] };
  if (damage === "future-result") loop.collect.value = { kind: "ref", source: "nodeOutput", nodeId: "future", path: ["value"] };
  if (damage === "item-type") { loop.items.schema.items.type = "boolean"; loop.items.value.items[0].value = true; }
  if (damage === "literal-type") loop.collect.value = { kind: "literal", value: true };
  if (damage === "expanded-budget") { loop.maxItems = 100; const inner = structuredClone(loop); inner.id = "inner"; inner.collect.value.nodeId = "inner"; loop.body = seq(inner); value.steps[0].parameters.value = "{{inner.item}}"; }
  if (damage === "malformed-flow") value.metadata.controlFlow.root.kind = "unsupported";
  const result = validate(value);
  expect(result).toMatchObject({ passed: false, schema_ok: false, failed_rules: expect.arrayContaining(["WORKSPACE_READ_COMPILATION"]) });
  expect(result.score).toBeLessThan(1); expect(result.errors.some(issue => issue.startsWith("WORKSPACE_READ_COMPILATION:"))).toBe(true);
});

test("ordinary drafts retain existing generic validation rather than fabricating read compilation", () => {
  const value = source(); delete value.metadata; value.steps[0].parameters.value = "fixture";
  expect(validate(value)).toEqual(validator.validatePlan("Draft", stringify(value), "Platform Admin"));
});

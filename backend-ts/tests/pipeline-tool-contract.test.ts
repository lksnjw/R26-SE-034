import { expect, test } from "vitest";
import { validateToolInput, validateToolSchemaProfile } from "../src/tools/tool-input-schema.js";
// @ts-expect-error Deployment helper is JavaScript; its contracts are checked below.
import { pipelineTools } from "../scripts/pipeline-bridge-tools.mjs";

test("nullable scalar output validates null and the exact declared type", () => {
  const schema = {type: "object", properties: {text: {type: ["string", "null"]}}, required: ["text"]};
  expect(validateToolSchemaProfile(schema)).toEqual([]);
  expect(validateToolInput(schema, {text: null})).toEqual([]);
  expect(validateToolInput(schema, {text: "OCR text"})).toEqual([]);
  expect(validateToolInput(schema, {text: 123})).not.toEqual([]);
  expect(validateToolInput(schema, {})).not.toEqual([]);
});
test("enum constraints are validated rather than ignored", () => {
  const schema = {type: "object", properties: {kind: {type: "string", enum: ["document_chunk", "schema"]}}};
  expect(validateToolInput(schema, {kind: "document_chunk"})).toEqual([]);
  expect(validateToolInput(schema, {kind: "invented"})).not.toEqual([]);
  expect(validateToolSchemaProfile({type: "string", enum: [{secret: true}]})).not.toEqual([]);
});
test("unsupported unions and constraints remain refused", () => {
  for (const schema of [{type: ["object", "null"], properties: {}}, {type: ["string", "number"]},
    {type: ["null", "null"]}, {type: "string", minLength: 1}, {type: "object", anyOf: []}])
    expect(validateToolSchemaProfile(schema)).not.toEqual([]);
});
test("every pipeline business/output contract fits the engine and uses its own origin", async () => {
  const tools = await pipelineTools("https://pipeline.example.test");
  expect(tools).toHaveLength(5);
  for (const tool of tools) {
    expect(tool.spec.execution.endpoint).toMatch(/^https:\/\/pipeline\.example\.test\/v1\//);
    expect(tool.spec.execution.approvedOrigins).toEqual(["https://pipeline.example.test"]);
    expect(tool.spec.security.authHeader).toBe("X-API-Key");
    expect(validateToolSchemaProfile(tool.spec.inputSchema)).toEqual([]);
    expect(validateToolSchemaProfile(tool.spec.outputSchema)).toEqual([]);
  }
});

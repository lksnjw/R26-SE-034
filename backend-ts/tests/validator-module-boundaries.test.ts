import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const source = (path: string) => readFile(resolve(path), "utf8");

describe("validator responsibility boundaries", () => {
  test("keeps process-local token and dispatch authority outside policy evaluation", async () => {
    const [validator, authority, stepStructure] = await Promise.all([
      source("src/validator/registry-validator.ts"),
      source("src/validator/capability-authority.ts"),
      source("src/validator/step-structure.ts"),
    ]);
    expect(validator.split(/\r?\n/).length).toBeLessThanOrEqual(1_100);
    expect(authority.split(/\r?\n/).length).toBeLessThanOrEqual(200);
    expect(stepStructure.split(/\r?\n/).length).toBeLessThanOrEqual(150);
    expect(validator).toContain('from "./capability-authority.js"');
    expect(validator).toContain('from "./step-structure.js"');
    expect(validator).toContain(
      'export type { DispatchCapability, ValidationToken } from "./capability-authority.js"',
    );
    expect(validator).not.toContain('from "node:crypto"');
    expect(validator).not.toContain("processSigningKey");
    expect(validator).not.toContain("tokenProofs");
    expect(validator).not.toContain("mintedCapabilities");
    expect(authority).toContain("export function mintValidationToken");
    expect(authority).toContain("export function verifyValidationToken");
    expect(authority).toContain("export function mintDispatchCapability");
    expect(authority).toContain("export function consumeDispatchCapability");
    expect(stepStructure).toContain("export function validateAnalysisStepStructure");
    expect(stepStructure).toContain("export function validateAgentStepStructure");
    expect(stepStructure).not.toMatch(/from .*repository|from .*registry|providerRuntime|dispatchReadTool|mintDispatch|consumeDispatch/);
  });
});

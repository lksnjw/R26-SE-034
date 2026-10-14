import { describe, expect, it } from "vitest";
// @ts-expect-error Local operator JavaScript module has no declaration file.
import { assertDiscoveredWorkspaceScope } from "../scripts/discovered-tools-workspace-qa.mjs";

describe("unreviewed Docker workspace operator scope", () => {
  const valid = {
    LCWE_REAL_MODEL_QA: "synthetic-docker-only",
    LCWE_DISCOVERED_QA: "unreviewed-docker-only",
    GENERATION_BASE_URL: "https://openrouter.ai/api/v1",
    GENERATION_API_KEY: "unit-secret-not-a-credential",
    GENERATION_MODEL_PRIMARY: "deepseek/deepseek-v4.1-flash",
  };

  it("requires both scopes before any Docker or provider access", () => {
    expect(() => assertDiscoveredWorkspaceScope(valid)).not.toThrow();
  });

  it.each([
    { LCWE_REAL_MODEL_QA: undefined },
    { LCWE_REAL_MODEL_QA: "production" },
    { LCWE_DISCOVERED_QA: undefined },
    { LCWE_DISCOVERED_QA: "production" },
    { GENERATION_BASE_URL: "https://unreviewed.invalid/v1" },
    { GENERATION_API_KEY: " " },
    { GENERATION_MODEL_PRIMARY: "another-model" },
  ])("refuses incomplete or unrelated scope without exposing credentials (%j)", patch => {
    let failure: Error | undefined;
    try { assertDiscoveredWorkspaceScope({ ...valid, ...patch }); }
    catch (error) { failure = error as Error; }
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toMatch(/scope|synthetic-only/);
    expect(failure?.message).not.toContain(valid.GENERATION_API_KEY);
  });
});

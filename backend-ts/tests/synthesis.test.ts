import { resolve } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { ProviderRuntime, type RuntimeProviderConfiguration } from "../src/providers/runtime.js";
import { RegistryService } from "../src/registry/service.js";
import { Repository } from "../src/repository/store.js";
import { Executor } from "../src/runner/executor.js";
import { SynthesisFailure, SynthesisService, assembleCandidatePrompt } from "../src/synthesis/service.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";
import { CANDIDATE_SYSTEM_PROMPT } from "../src/prompts/contracts.js";

const configuration: RuntimeProviderConfiguration = { id: "provider_test", name: "Test", type: "openai_compatible", baseURL: "https://openrouter.ai/api/v1", apiKey: "test-key", model: "openai/gpt-4o-mini-2024-07-18", temperature: 0, timeoutMs: 1_000 };

describe("single-candidate synthesis", () => {
  test("live discovery does not trigger a second model rewrite or silently rename unknown steps", async () => {
    const yaml = "name: Partial delivery\ndescription: Unknown action must stay visible\ntrigger:\n  type: manual\nsteps:\n - id: echo\n   action: demo_echo\n   parameters:\n     value: test\n";
    const fetchImplementation = vi.fn<typeof fetch>(async () => providerResponse(yaml));
    const { service, registries } = await setup("tests/fixtures/chat-read-tools.json", "tests/fixtures/rules.json", fetchImplementation);
    const result = await service.synthesize({ prompt: "Create an echo workflow", userRole: "Platform Admin", liveTools: registries.snapshot().tools });
    expect(result.yaml).toBe(yaml.trim());
    expect(result.validation.passed).toBe(false);
    expect(result.validation.failed_rules).toContain("GLOBAL-SAFETY-001");
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  test("generation instructions preserve missing outcomes, policy and timezone uncertainty", async () => {
    const { registries } = await setup("tests/fixtures/tools.json", "tests/fixtures/rules.json", async () => providerResponse("unused"));
    const data = JSON.parse(assembleCandidatePrompt("Send daily invoices to the manager", "Platform Admin", registries));
    expect(data.USER_REQUEST).toBe("Send daily invoices to the manager");
    const prompt = CANDIDATE_SYSTEM_PROMPT;
    expect(prompt).toContain("metadata.unresolved_requirements");
    expect(prompt).toContain("Never ignore a relevant rule");
    expect(prompt).toContain("Never silently assume UTC");
    expect(prompt).not.toContain("IGNORE that rule completely");
    expect(prompt).not.toContain("omit that step entirely");
  });

  test.each([[], ["Delivery connector is unavailable"], null, {}, [""], Array(51).fill("Missing outcome")])("requirement blocker marker %j is verified rather than trusted as readiness", async (marker) => {
    const yaml = "name: Echo\ndescription: Read a value\ntrigger:\n  type: manual\nsteps:\n - id: read\n   action: demo.echo\n   parameters:\n     value: test\nmetadata:\n  unresolved_requirements: " + JSON.stringify(marker) + "\n";
    const { service } = await setup("tests/fixtures/chat-read-tools.json", "tests/fixtures/rules.json", async () => providerResponse(yaml));
    const result = await service.synthesize({ prompt: "Create a daily report", userRole: "Platform Admin" });
    const resolved = Array.isArray(marker) && marker.length === 0;
    expect(result.validation.passed).toBe(resolved);
    if (!resolved) expect(result.validation.failed_rules).toContain("UNRESOLVED_REQUIREMENTS");
  });

  test("a valid natural-language request produces a candidate that passes the existing gate", async () => {
    const yaml = `name: Echo request\ndescription: Echoes a value through the demo integration.\ntrigger:\n  type: manual\nsteps:\n  - id: echo_value\n    action: demo.echo\n    parameters:\n      value: hello\n`;
    const { service, registries } = await setup("tests/fixtures/tools.json", "tests/fixtures/rules.json", async () => providerResponse(yaml, { prompt_tokens: 30, completion_tokens: 20 }));
    const assembled = assembleCandidatePrompt("Echo hello", "Platform Admin", registries);
    expect(assembled).toContain("TOOL_REGISTRY_JSON");
    expect(assembled).toContain("input_schema");
    expect(assembled).toContain("demo.echo");
    const result = await service.synthesize({ prompt: "Echo hello", userRole: "Platform Admin" });
    expect(result.canExecute).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(result.validation.passed).toBe(true);
    expect(result.candidate.generation_metadata).toMatchObject({ measured: true, inputTokens: 30, outputTokens: 20, promptTemplateVersion: "prompt/candidate/v3" });
  });

  test("a self-approval candidate is rejected with the governing rule ID", async () => {
    const yaml = `name: Self approval\ndescription: Requests approval from the same principal who requested it.\ntrigger:\n  type: manual\nsteps:\n  - id: request_approval\n    action: approval.request_human_approval\n    parameters:\n      approval_reason: Purchase request\n      approver_role: finance_manager\n      requester_id: user-1\n      approver_id: user-1\n`;
    const { service } = await setup("fixtures/parity/http/runtime/all_tools_master_registry.json", "fixtures/parity/http/runtime/all_rules_master_registry.json", async () => providerResponse(yaml));
    const result = await service.synthesize({ prompt: "Let me approve my own purchase", userRole: "Platform Admin" });
    expect(result.canExecute).toBe(false);
    expect(result.validation.failed_rules).toContain("GLOBAL-SOD-001");
    expect(result.blocking_errors.length).toBeGreaterThan(0);
  });

  test("a malformed model response is an error and never becomes a candidate", async () => {
    const { service } = await setup("tests/fixtures/tools.json", "tests/fixtures/rules.json", async () => providerResponse("name: [broken"));
    await expect(service.synthesize({ prompt: "Echo hello", userRole: "Platform Admin" })).rejects.toThrow(
      "Generated response was malformed",
    );
  });

  test("generation failure is a clear 502-class error rather than a service-unavailable stub", async () => {
    const { service } = await setup("tests/fixtures/tools.json", "tests/fixtures/rules.json", async () => new Response("upstream failure", { status: 500 }));
    const error = await service.synthesize({ prompt: "Echo hello", userRole: "Platform Admin" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SynthesisFailure);
    expect((error as SynthesisFailure).status).toBe(502);
    expect((error as Error).message).toContain("Candidate generation failed");
  });

  test("synthesis still receives the full registry and generates a workflow after adding the read-only selector", async () => {
    const yaml = `name: Attendance lookup\ndescription: Fetches an employee attendance record.\ntrigger:\n  type: manual\nsteps:\n  - id: fetch_employee_attendance\n    action: fetch_attendance\n    parameters:\n      employeeId: EMP-005\n`;
    const { service, registries } = await setup(
      "fixtures/parity/http/runtime/all_tools_master_registry.json",
      "fixtures/parity/http/runtime/all_rules_master_registry.json",
      async () => providerResponse(yaml),
    );
    const assembled = assembleCandidatePrompt(
      "Show attendance for employee EMP-005",
      "Platform Admin",
      registries,
    );

    expect(registries.snapshot().tools).toHaveLength(17);
    expect(assembled).toContain("demo.echo");
    expect(assembled).toContain("procurement.create_purchase_order");
    const result = await service.synthesize({
      prompt: "Show attendance for employee EMP-005",
      userRole: "Platform Admin",
    });
    expect(result.canExecute).toBe(true);
    expect(result.candidate.yaml).toBe(yaml.trim());
  });
});

/*******************************************************************************
 * Function: setup
 *
 * Builds registry, validation, and provider services for synthesis tests.
 ******************************************************************************/
async function setup(toolPath: string, rulePath: string, fetchImplementation: typeof fetch) {
  const repository = new Repository(null);
  const registries = await RegistryService.load(resolve(toolPath), resolve(rulePath));
  const validator = new RegistryValidator(registries, repository);
  const executor = new Executor(new ToolRegistry(), validator);
  const providers = new ProviderRuntime(repository, executor, fetchImplementation);
  providers.activate(configuration);
  return { service: new SynthesisService(providers, registries, validator), repository, registries };
}

/*******************************************************************************
 * Function: providerResponse
 *
 * Creates a mock provider completion response with optional usage data.
 ******************************************************************************/
function providerResponse(content: string, usage?: { prompt_tokens: number; completion_tokens: number }): Response {
  return Response.json({ choices: [{ message: { content } }], ...(usage === undefined ? {} : { usage }) });
}

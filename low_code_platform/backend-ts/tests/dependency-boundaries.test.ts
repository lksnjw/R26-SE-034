import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { boundedJSONRequest } from "../src/core/bounded-json-request.js";
import { OpenAICompatibleClient } from "../src/providers/openai-compatible.js";
import { GovernanceAdapter, type GovernanceRequest } from "../src/governance/adapter.js";
import { PolicyGateClient } from "../src/governance/policy-gate-client.js";
import { GovernanceService } from "../src/governance/service.js";
import { GovernedValidationGate } from "../src/governance/gate.js";
import { RegistryService } from "../src/registry/service.js";
import { Repository } from "../src/repository/store.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";

afterEach(() => vi.useRealTimers());
const request: GovernanceRequest = { requestId: "req-boundary", user: { id: "actor", role: "Platform Admin", department: null }, intent: "Read", proposedActions: ["demo.echo"], caseContext: {} };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const heldBody = () => ({ ok: true, status: 200, body: null, json: () => new Promise<unknown>(() => {}) }) as Response;
const adapter = (fetchImplementation: typeof fetch) => new GovernanceAdapter({ url: "https://policy.example.test/evaluate", apiKey: "fixture-only", timeoutMs: 20, source: "primary", fetchImplementation });
const policy = (fetchImplementation: typeof fetch) => new PolicyGateClient({ url: "https://policy.example.test", apiKey: "fixture-only", timeoutMs: 20, fetchImplementation });
const client = (fetchImplementation: typeof fetch) => new OpenAICompatibleClient({ baseURL: "https://model.example.test/v1", apiKey: "fixture-only", model: "fixture-v1", timeoutMs: 20, fetchImplementation });

test.each(["generate", "query", "governance", "policy"])("%s bounds ignored-signal fetch and JSON-body stalls", async (kind) => {
  for (const stage of ["fetch", "body"]) {
    vi.useFakeTimers();
    const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(async () => stage === "fetch" ? new Promise<Response>(() => {}) : heldBody());
    const provider = client(fetchImplementation);
    const result = kind === "generate" ? provider.generate("prompt", "fixture-v1") : kind === "query" ? provider.queryWithTools([{ role: "user", content: "Read" }], [], {}) :
      kind === "governance" ? adapter(fetchImplementation).fetchPolicy(request) : policy(fetchImplementation).evaluate(request);
    const assertion = kind === "policy" ? expect(result).resolves.toMatchObject({ outcome: "fallback", reason: "policy gate request timed out" }) : expect(result).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(20); await assertion;
    expect(fetchImplementation).toHaveBeenCalledOnce(); expect(fetchImplementation.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
  }
});

test("one HTTP deadline covers headers plus body, not a fresh timeout for each", async () => {
  vi.useFakeTimers();
  const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, 15));
    return { ...heldBody(), json: async () => { await new Promise(resolve => setTimeout(resolve, 15)); return { late: true }; } } as Response;
  });
  const result = boundedJSONRequest(fetchImplementation, "https://fixture.example.test", {}, 20, "fixture");
  const assertion = expect(result).rejects.toMatchObject({ name: "OperationDeadlineExceeded" });
  await vi.advanceTimersByTimeAsync(20); await assertion;
  await vi.advanceTimersByTimeAsync(15); expect(vi.getTimerCount()).toBe(0);
});

test.each(["generate", "query", "governance", "policy"])("pre-cancelled %s cannot dispatch or downgrade cancellation", async (kind) => {
  const fetchImplementation = vi.fn<typeof fetch>(); const controller = new AbortController(); controller.abort();
  const provider = client(fetchImplementation);
  const result = kind === "generate" ? provider.generate("prompt", "fixture-v1", controller.signal) : kind === "query" ? provider.queryWithTools([], [], { signal: controller.signal }) :
    kind === "governance" ? adapter(fetchImplementation).fetchPolicy(request, controller.signal) : policy(fetchImplementation).evaluate(request, controller.signal);
  if (kind === "policy") await expect(result).resolves.toMatchObject({ outcome: "deny" });
  else await expect(result).rejects.toMatchObject({ kind: "cancelled" });
  expect(fetchImplementation).not.toHaveBeenCalled();
});

test.each([401, 403])("HTTP %s policy authorization never becomes a fallback", async (status) => {
  await expect(adapter(vi.fn<typeof fetch>().mockResolvedValue(json({}, status))).fetchPolicy(request)).rejects.toMatchObject({ kind: "authorization" });
  await expect(policy(vi.fn<typeof fetch>().mockResolvedValue(json({}, status))).evaluate(request)).resolves.toMatchObject({ outcome: "deny" });
});

test.each([
  {}, { decision: "unrecognized" }, { decision: "allow", request_id: "wrong" }, { decision: "allow", allowed: false },
  { decision: "allow", conditions: "malformed" }, { decision: "allow", reason: 23 },
])("malformed/contradictory policy answer %j fails closed", async (body) => {
  await expect(policy(vi.fn<typeof fetch>().mockResolvedValue(json(body))).evaluate(request)).resolves.toMatchObject({ outcome: "deny" });
});

test.each([
  { decision: "allow_with_conditions", conditions: ["manager approval"] },
  { decision: "allow_with_conditions", conditions: [] },
  { decision: "allow", conditions: ["must approve"] },
])("conditional policy answer %j requires review", async (body) => {
  await expect(policy(vi.fn<typeof fetch>().mockResolvedValue(json(body))).evaluate(request)).resolves.toMatchObject({ outcome: "review" });
});

test("matching unconditional allow remains supported", async () => {
  await expect(policy(vi.fn<typeof fetch>().mockResolvedValue(json({ decision: "allow", request_id: request.requestId, conditions: [] }))).evaluate(request)).resolves.toMatchObject({ outcome: "allow", conditions: [] });
});

test.each(["authorization", "parse", "cancelled"])("primary %s cannot use secondary or cached read authorization", async (kind) => {
  const repository = new Repository();
  const registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json"));
  const primaryFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ policyVersion: "v1", rules: [] }));
  const secondaryFetch = vi.fn<typeof fetch>().mockResolvedValue(json({ policyVersion: "v1", rules: [] }));
  const service = new GovernanceService(adapter(primaryFetch), adapter(secondaryFetch), 10_000, registries, repository);
  const evaluate = vi.fn(async () => "locally valid");
  expect((await service.govern(request, true, evaluate)).allowed).toBe(true);
  const controller = new AbortController();
  if (kind === "authorization") primaryFetch.mockResolvedValueOnce(json({}, 403));
  else if (kind === "parse") primaryFetch.mockResolvedValueOnce(json({ policyVersion: "bad", rules: "malformed" }));
  else { primaryFetch.mockImplementationOnce(async () => { controller.abort(); return json({ policyVersion: "late", rules: [] }); }); }
  const outcome = await service.govern(request, true, evaluate, controller.signal);
  expect(outcome.allowed).toBe(false); expect(secondaryFetch).not.toHaveBeenCalled(); expect(evaluate).toHaveBeenCalledOnce();
  expect((await repository.snapshot()).governancePolicy?.lastPrimaryPolicyVersion).toBe("v1");
});

test("validation gate independently rejects a permissive injected client with unenforced conditions", async () => {
  const repository = new Repository();
  const registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, repository);
  const service = new GovernanceService(null, null, 0, registries, repository);
  const injected = { evaluate: async () => ({ outcome: "allow", reason: "conditional", conditions: ["manager approval"] }) } as unknown as PolicyGateClient;
  const gate = new GovernedValidationGate(service, validator, registries, repository, injected);
  const result = await gate.validateAndIssueToken("Read", "name: Read\ndescription: Read\ntrigger:\n  type: manual\nsteps:\n  - id: read\n    action: demo.echo\n    parameters:\n      value: ok\n", request.user);
  expect(result.token).toBeNull(); expect(result.result.passed).toBe(false);
  expect(result.result.failed_rules).toContain("GOVERNANCE-HUMAN-REVIEW");
});

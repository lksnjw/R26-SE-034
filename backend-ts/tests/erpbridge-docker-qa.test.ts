import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
// Local operator scripts are deliberately outside the production bundle.
// @ts-expect-error JavaScript operator entrypoint has no declaration file
import { qaEnvironment, qaMode, qaProjectName, assertEmptyQaProject, assertQaResourceNamesAvailable, assertQaBridgeContainer, dockerFailureCategory, runDockerCommand, qaCompose, qaProject, qaRegistryPaths } from "../scripts/erpbridge-docker-qa.mjs";
import { execFileSync } from "node:child_process";
// @ts-expect-error JavaScript operator script has no declaration file
import { qaReadTool } from "../scripts/seed-erpbridge-qa-read.mjs";
// @ts-expect-error JavaScript operator script has no declaration file
import { qaReviewedDefinition } from "../scripts/qualify-erpbridge-qa-read.mjs";

describe("isolated Docker ERPBridge qualification", () => {
  const admittedResource = () => {
    const resource = qaReadTool(); resource.metadata.resourceDigest = "a".repeat(64);
    resource.spec.execution.approvedOrigins = ["http://mock-erp:8081"];
    return resource;
  };
  it("reviews exactly the literal resource and freezes its digest without modifying the caller", () => {
    const resource = admittedResource(), before = structuredClone(resource), definition = qaReviewedDefinition(resource);
    expect(definition.bridge_contract.resource_digest).toBe("a".repeat(64));
    expect(definition.input_schema).toEqual({ type: "object", properties: {} });
    expect(definition.allowed_roles).toEqual(["Platform Admin"]);
    expect(definition.is_read_only).toBe(true);
    expect(resource).toEqual(before);
  });
  it.each(["origin", "method", "schema", "roles", "version", "digest"])("refuses synthetic review when the literal %s contract differs", field => {
    const resource = admittedResource();
    if (field === "origin") resource.spec.execution.approvedOrigins = ["https://external.invalid"];
    if (field === "method") resource.spec.execution.method = "POST";
    if (field === "schema") resource.spec.inputSchema.properties = { arbitrary: { type: "string" } };
    if (field === "roles") resource.spec.security.allowedRoles = ["different_role"];
    if (field === "version") resource.metadata.version = "2.0.0";
    if (field === "digest") resource.metadata.resourceDigest = "not-a-digest";
    expect(() => qaReviewedDefinition(resource)).toThrow(/exact explicitly reviewed/);
  });
  it("registers only a literal synthetic GET contract without remote model instructions", () => {
    const tool = qaReadTool();
    expect(tool.metadata).toEqual({ name: "qa_list_departments", version: "1.0.0", module: "local_qa" });
    expect(tool.spec.execution).toEqual({ type: "http", method: "GET", endpoint: "/api/resource/Department" });
    expect(tool.spec.inputSchema).toEqual({ type: "object", properties: {}, required: [] });
    expect(tool.spec.annotations.readOnlyHint).toBe(true);
    expect(tool.spec.outputSchema.required).toEqual(["data"]);
    expect(JSON.stringify(tool)).not.toMatch(/api_secret|API_AUTH_TOKEN|https:\/\//);
  });
  it("uses loopback ports, internal Redis and an untouched external bridge build", () => {
    const config = parse(readFileSync(qaCompose, "utf8"));
    expect(config.services["erpbridge-server"].ports).toEqual(["127.0.0.1:18080:8080"]);
    expect(config.services["mock-erp"].ports).toEqual(["127.0.0.1:18081:8081"]);
    expect(config.services.redis.ports).toBeUndefined();
    expect(config.services["erpbridge-server"].build.context).toBe("../../../ERPBridge");
    expect(config.services["erpbridge-server"].build.dockerfile).toBeUndefined();
    expect(config.services["erpbridge-server"].build.dockerfile_inline).toContain("go build -mod=readonly -p=2");
    expect(config.services["erpbridge-server"].environment.MCP_ENABLE_TEST_TOOLS).toBe("false");
    expect(config.services["erpbridge-server"].environment.ERP_BASE_URL).toBe("http://mock-erp:8081");
    expect(Object.values(config.services).every((service: any) => Boolean(service.healthcheck))).toBe(true);
    expect(qaProject).toBe("lcwe-erpbridge-qa");
    for (const path of qaRegistryPaths) expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
  });
  it("generates matching disposable credentials, ignoring inherited QA secrets", () => {
    const a = qaEnvironment({ PATH: "fixture", LCWE_QA_BRIDGE_TOKEN: "not-reused" }), b = qaEnvironment();
    const [credential] = JSON.parse(a.LCWE_QA_MOCK_CREDENTIALS).credentials;
    expect(credential.role).toBe("admin");
    expect(credential.identity).toBe("lcwe-local-qa");
    expect(a.LCWE_QA_ERP_PRIMARY_KEY).toBe(`token ${credential.api_key}:${credential.api_secret}`);
    expect(a.LCWE_QA_BRIDGE_TOKEN).toMatch(/^[a-f0-9]{64}$/);
    expect(a.LCWE_QA_BRIDGE_TOKEN).not.toBe(b.LCWE_QA_BRIDGE_TOKEN);
    expect(a.PATH).toBe("fixture");
  });
  it("selects only the fixed QA project or an explicit bounded fresh-run namespace", () => {
    expect(qaProjectName()).toBe("lcwe-erpbridge-qa");
    expect(qaProjectName({ LCWE_QA_RUN_ID: "20261010b1" })).toBe("lcwe-erpbridge-qa-20261010b1");
    expect(qaProjectName({ LCWE_QA_RUN_ID: "read-2" })).toBe("lcwe-erpbridge-qa-read-2");
    expect(qaProjectName({ LCWE_QA_RUN_ID: "x".repeat(24) })).toBe(`lcwe-erpbridge-qa-${"x".repeat(24)}`);
    for (const runId of ["", " ", "Upper", "x".repeat(25), "-first", "last-", "../old", "prod_name", "a\nb", "a\n", "a\r\n", "a.b", null, 1]) {
      expect(() => qaProjectName({ LCWE_QA_RUN_ID: runId })).toThrow(/LCWE_QA_RUN_ID/);
      expect(() => qaEnvironment({ LCWE_QA_RUN_ID: runId })).toThrow(/LCWE_QA_RUN_ID/);
    }
  });
  it("shares the selected project with every imported QA helper", () => {
    const result = execFileSync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "--eval",
      `const qa = await import("./scripts/erpbridge-docker-qa.mjs");
       await import("./scripts/seed-erpbridge-qa-read.mjs");
       await import("./scripts/qualify-erpbridge-qa-read.mjs");
       await import("./scripts/erpbridge-workspace-qa.mjs");
       const container = { Config: { Labels: { "com.docker.compose.project": qa.qaProject, "com.docker.compose.service": "erpbridge-server" }, Env: ["ERP_BASE_URL=http://mock-erp:8081", "API_AUTH_TOKEN=" + "a".repeat(64)] }, NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "18080" }] } } };
       if (qa.assertQaBridgeContainer(container) !== "a".repeat(64)) throw new Error("Selected QA validation failed");
       container.Config.Labels["com.docker.compose.project"] = "lcwe-erpbridge-qa";
       try { qa.assertQaBridgeContainer(container); throw new Error("Old project was accepted"); }
       catch (error) { if (!/refusing discovery/.test(error.message)) throw error; }
       console.log(qa.qaProject);`],
    // This fresh process loads the TypeScript application graph, not a network
    // call. Give cold startup its own bounded budget under the full regression.
    { cwd: new URL("..", import.meta.url), env: { ...process.env, LCWE_QA_RUN_ID: "test-fresh" }, encoding: "utf8", windowsHide: true, timeout: 15_000 });
    expect(result.trim()).toBe("lcwe-erpbridge-qa-test-fresh");
  }, 20_000);
  it("preserves base volumes while refusing exact selected resource-name collisions regardless of labels", () => {
    const base = { containers: "", volumes: "lcwe-erpbridge-qa_erpbridge-data\nlcwe-erpbridge-qa_mockerp-data\nlcwe-erpbridge-qa_redis-data\n", networks: "bridge\nhost\nnone\n" };
    const project = qaProjectName({ LCWE_QA_RUN_ID: "fresh" });
    expect(() => assertQaResourceNamesAvailable(base, project)).not.toThrow();
    expect(() => assertQaResourceNamesAvailable(base)).toThrow(/refusing/);
    for (const volume of ["erpbridge-data", "mockerp-data", "redis-data"])
      expect(() => assertQaResourceNamesAvailable({ ...base, volumes: `${base.volumes}${project}_${volume}\r\n` }, project)).toThrow(/refusing/);
    for (const service of ["erpbridge-server", "mock-erp", "redis"])
      expect(() => assertQaResourceNamesAvailable({ ...base, containers: `${project}-${service}-1\n` }, project)).toThrow(/refusing/);
    expect(() => assertQaResourceNamesAvailable({ ...base, networks: `${project}_default\n` }, project)).toThrow(/refusing/);
    expect(() => assertQaResourceNamesAvailable({ ...base, volumes: `${project}-other_erpbridge-data` }, project)).not.toThrow();
    expect(() => assertEmptyQaProject("", `${project}_redis-data`)).toThrow(/refusing/);
  });
  it("refuses retained project data and ambiguous operator commands", () => {
    expect(() => assertEmptyQaProject("", "")).not.toThrow();
    expect(() => assertEmptyQaProject("container", "")).toThrow(/refusing/);
    expect(() => assertEmptyQaProject("", "retained-volume")).toThrow(/refusing/);
    expect(qaMode(["--check"])).toBe("--check");
    expect(qaMode(["--start"])).toBe("--start");
    expect(qaMode(["--verify"])).toBe("--verify");
    for (const args of [[], ["--start", "--force"], ["--down"], ["--prune"]]) expect(() => qaMode(args)).toThrow(/Use/);
  });
  it("keeps the deprecated sync command read-only without name-derived permissions", () => {
    const source = readFileSync(new URL("../scripts/sync-erpbridge-tools.mjs", import.meta.url), "utf8");
    expect(source).toContain('import("./verify-erpbridge-registry.mjs")');
    expect(source).not.toMatch(/@erpbridge\/sdk|writeFile|existing\.push|isReadOnly\s*=/);
  });
  it("classifies operator failures without exposing upstream text or credentials", () => {
    expect(dockerFailureCategory("token SECRET: failed to resolve source metadata")).toBe("image registry or download failed");
    expect(dockerFailureCategory("SECRET Internal Server Error pipe")).toBe("Docker engine unavailable");
    expect(dockerFailureCategory("arbitrary sensitive output")).toBe("Docker command failed");
    expect(dockerFailureCategory("no space left on device")).toBe("Docker resource shortage");
    expect(dockerFailureCategory("container is unhealthy")).toBe("service health check failed");
  });
  it("clears a successful Windows command timer without terminating any process", async () => {
    vi.useFakeTimers();
    try {
      let finish: any;
      const execute = vi.fn((_command: string, _args: string[], _options: any, callback: any) => { finish = callback; return { pid: 4242, exitCode: null, signalCode: null }; });
      const result = runDockerCommand(["info"], {}, 50, execute, "win32");
      finish(null, "linux");
      expect(await result).toBe("linux");
      await vi.advanceTimersByTimeAsync(100);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[2].timeout).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it.each([false, true])("terminates only the owned Windows tree and reports cleanup confirmation truthfully (kill failure %s)", async killFailed => {
    vi.useFakeTimers();
    try {
      let finishDocker: any, finishKill: any;
      const execute = vi.fn((command: string, _args: string[], _options: any, callback: any) => {
        if (command === "docker") finishDocker = callback; else finishKill = callback;
        return { pid: command === "docker" ? 4242 : 4243, exitCode: null, signalCode: null };
      });
      const result = runDockerCommand(["compose", "up"], {}, 50, execute, "win32");
      await vi.advanceTimersByTimeAsync(50);
      expect(execute.mock.calls[1]?.[0]).toBe("taskkill");
      expect(execute.mock.calls[1]?.[1]).toEqual(["/PID", "4242", "/T", "/F"]);
      expect(execute.mock.calls[1]?.[2].timeout).toBe(10_000);
      const rejected = expect(result).rejects.toThrow(killFailed ? /cleanup was not confirmed/ : /process tree was terminated/);
      finishDocker(new Error("sensitive upstream output"));
      finishKill(killFailed ? new Error("sensitive taskkill output") : null);
      await rejected;
      await expect(result).rejects.not.toThrow(/sensitive/);
    } finally { vi.useRealTimers(); }
  });
  it("does not target a PID once its owned child is known to have exited", async () => {
    vi.useFakeTimers();
    try {
      const execute = vi.fn(() => ({ pid: 4242, exitCode: 0, signalCode: null }));
      const result = runDockerCommand(["compose", "up"], {}, 50, execute, "win32");
      const rejected = expect(result).rejects.toThrow(/cleanup was not confirmed/);
      await vi.advanceTimersByTimeAsync(50);
      await rejected;
      expect(execute).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it("refuses to use credentials from unrelated, external-ERP or exposed containers", () => {
    const container = { Config: { Labels: { "com.docker.compose.project": qaProject, "com.docker.compose.service": "erpbridge-server" }, Env: ["ERP_BASE_URL=http://mock-erp:8081", `API_AUTH_TOKEN=${"a".repeat(64)}`] }, NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "18080" }] } } };
    expect(assertQaBridgeContainer(container)).toBe("a".repeat(64));
    for (const alter of [
      (item: any) => { item.Config.Labels["com.docker.compose.project"] = "production"; },
      (item: any) => { item.Config.Env[0] = "ERP_BASE_URL=https://production.invalid"; },
      (item: any) => { item.NetworkSettings.Ports["8080/tcp"][0].HostIp = "0.0.0.0"; },
      (item: any) => { item.Config.Env[1] = "API_AUTH_TOKEN="; },
    ]) { const bad = structuredClone(container); alter(bad); expect(() => assertQaBridgeContainer(bad)).toThrow(/refusing/); }
  });
});

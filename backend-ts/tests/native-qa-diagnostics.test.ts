import { readFile } from "node:fs/promises";
import { mkdtemp, readFile as readReport, rm, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { closeSync, fsyncSync, writeSync } from "node:fs";
import { FirestoreRecordCodec } from "../src/storage/firestore-record-codec.js";
import { expect, test, vi, afterEach } from "vitest";
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync), closeSync: vi.fn(actual.closeSync), writeSync: vi.fn(actual.writeSync) };
});
afterEach(async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(fsyncSync).mockReset().mockImplementation(actual.fsyncSync);
  vi.mocked(closeSync).mockReset().mockImplementation(actual.closeSync);
  vi.mocked(writeSync).mockReset().mockImplementation(actual.writeSync);
});
// @ts-expect-error Operator-only JavaScript diagnostics, not an application dependency.
import { assertNativeResponseContinues, NativeQaStop, safeNativeFailureDiagnostic, createNativeQaContext, createNativeQaReport, createNativePrivatePolicyCapture } from "../scripts/native-qa-diagnostics.mjs";

const privateConfig = { FIRESTORE_PROJECT_ID: "demo-lcwe-records", FIRESTORE_DATABASE_ID: "(default)",
  FIRESTORE_WORKSPACE_ID: `test_${"a".repeat(32)}_native`, STORAGE_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") };
const privateScope = { projectId: privateConfig.FIRESTORE_PROJECT_ID, databaseId: privateConfig.FIRESTORE_DATABASE_ID, workspaceId: privateConfig.FIRESTORE_WORKSPACE_ID };
const campaignSha256 = "b".repeat(64), artifactSha256 = "c".repeat(64), policyHash = "d".repeat(64);
const privateFixture = (decision = "deny") => ({
  operation: { id: "chatop_RAW_SECRET_SENTINEL", status: "ANSWERED", assistantMessageId: "msg_RAW_SECRET_SENTINEL" },
  message: { id: "msg_RAW_SECRET_SENTINEL", operationId: "chatop_RAW_SECRET_SENTINEL", text: "RAW_SECRET_SENTINEL",
    artifacts: { intent: "POLICY_DENIAL", policyCheck: { decision, source: "local_model", reason: "RAW_SECRET_SENTINEL original receipt", fallbackUsed: true,
      policyVersion: "private-original-version", model: "private-original-model", promptTemplateVersion: "prompt/local-policy/v2", policyHash } } },
});

test.each(["deny", "review", "unavailable"])("private %s receipt is encrypted and fsynced before policy exception without proposal dereference", async decision => {
  const directory = await mkdtemp(join(tmpdir(), "native-private-policy-")), fixture = privateFixture(decision);
  const getter = vi.fn(() => { throw new Error("RAW_SECRET_SENTINEL"); });
  Object.defineProperty(fixture.message.artifacts, "proposal", { get: getter });
  Object.defineProperty(fixture.message, "text", { get: getter });
  const nodeContext = { workflowId: "wf_PRIVATE", nodeId: "node_PRIVATE", baseVersion: 2, baseHash: `sha256:${"e".repeat(64)}` };
  try {
    const report = createNativeQaReport(join(directory, "safe.jsonl")), qa = createNativeQaContext(report.record); qa.stage("node_proposal");
    const capturePolicyStop = createNativePrivatePolicyCapture({ config: privateConfig, campaignSha256, artifactSha256 });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(directory); let failure: unknown;
    try { qa.check("POLICY_CONTINUES", () => assertNativeResponseContinues(fixture.message, { stage: "node_proposal", operation: fixture.operation, nodeContext, capturePolicyStop })); }
    catch (error) { failure = error; } finally { cwd.mockRestore(); }
    expect(safeNativeFailureDiagnostic(failure)).toMatchObject({ check: "POLICY_CONTINUES", decision, code: "POLICY_STOP", privatePolicyCaptured: true, promptTemplateVersion: "prompt/local-policy/v2", policyHash });
    report.finish(false, qa.failure(failure));
    const bytes = await readReport(join(directory, "dist/qa-private-policy", `${campaignSha256}.json`));
    expect(bytes.toString()).not.toContain("RAW_SECRET_SENTINEL");
    expect(safeNativeFailureDiagnostic(failure).ciphertextSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    const packet = JSON.parse(bytes.toString());
    const decoded = new FirestoreRecordCodec(privateConfig.STORAGE_ENCRYPTION_KEY, privateScope).decodeHead({ ...packet, payload: Buffer.from(packet.payload, "base64") });
    expect(decoded).toEqual({ profile: "native-private-policy-stop/v1", purpose: "original-saved-policy-receipt-diagnosis", stage: "node_proposal", campaignSha256, artifactSha256,
      authenticatedSavedResponse: { operationId: fixture.operation.id, messageId: fixture.message.id, receipt: fixture.message.artifacts.policyCheck },
      originalHarnessRequest: { profile: "native-harness-request-context/v1", serverPolicyContextVerified: false, nodeContext } });
    const publicBytes = await readReport(join(directory, "safe.jsonl"), "utf8");
    expect(publicBytes).not.toMatch(/RAW_SECRET_SENTINEL|private-original|wf_PRIVATE|node_PRIVATE|operationId|messageId|reason|STORAGE_ENCRYPTION_KEY/);
    expect(getter).not.toHaveBeenCalled();
    const exclusiveCwd = vi.spyOn(process, "cwd").mockReturnValue(directory);
    try { expect(() => capturePolicyStop({ ...fixture, stage: "node_proposal" })).toThrow(NativeQaStop); }
    finally { exclusiveCwd.mockRestore(); }
    expect(await readReport(join(directory, "dist/qa-private-policy", `${campaignSha256}.json`))).toEqual(bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each(["encryption", "write", "fsync", "hostile-reason", "oversize-reason"])("private capture %s failure is fatal, sanitized and cannot approve", async fault => {
  const directory = await mkdtemp(join(tmpdir(), "native-private-fail-")), fixture = privateFixture();
  const getter = vi.fn(() => { throw new Error("RAW_SECRET_SENTINEL"); });
  if (fault === "hostile-reason") Object.defineProperty(fixture.message.artifacts.policyCheck, "reason", { get: getter });
  if (fault === "oversize-reason") fixture.message.artifacts.policyCheck.reason = "x".repeat(1001);
  if (fault === "write") vi.mocked(writeSync).mockImplementationOnce(() => { throw new Error("RAW_SECRET_SENTINEL"); });
  if (fault === "fsync") vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error("RAW_SECRET_SENTINEL"); });
  const capturePolicyStop = createNativePrivatePolicyCapture({ config: { ...privateConfig, ...(fault === "encryption" ? { STORAGE_ENCRYPTION_KEY: "RAW_SECRET_SENTINEL" } : {}) }, campaignSha256, artifactSha256 });
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(directory); let failure: unknown;
  try { assertNativeResponseContinues(fixture.message, { stage: "query", operation: fixture.operation, capturePolicyStop }); }
  catch (error) { failure = error; } finally { cwd.mockRestore(); }
  try {
    expect(failure).toBeInstanceOf(NativeQaStop);
    expect(safeNativeFailureDiagnostic(failure)).toEqual({ stage: "query", code: "PRIVATE_POLICY_CAPTURE_FAILED" });
    expect(JSON.stringify(failure)).not.toContain("RAW_SECRET_SENTINEL"); expect(getter).not.toHaveBeenCalled();
    if (["write", "fsync"].includes(fault)) expect(closeSync).toHaveBeenCalled();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("valid allow never invokes private capture or creates private output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-private-allow-")), capturePolicyStop = vi.fn();
  try {
    expect(() => assertNativeResponseContinues({ artifacts: { policyCheck: { decision: "allow" } } }, { capturePolicyStop })).not.toThrow();
    expect(capturePolicyStop).not.toHaveBeenCalled(); expect(await readdir(directory)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test.each([undefined, { decision: "allow" }])("generic blocked response with %j policy does not capture a policy sidecar", policyCheck => {
  const capturePolicyStop = vi.fn(); let failure: unknown;
  try { assertNativeResponseContinues({ artifacts: { blocked: true, ...(policyCheck ? { policyCheck } : {}) } }, { stage: "query", capturePolicyStop }); }
  catch (error) { failure = error; }
  expect(safeNativeFailureDiagnostic(failure)).toMatchObject({ stage: "query", code: "RESPONSE_BLOCKED" });
  expect(safeNativeFailureDiagnostic(failure).privatePolicyCaptured).toBeUndefined(); expect(capturePolicyStop).not.toHaveBeenCalled();
});

test("contradictory POLICY_DENIAL with allow keeps its fixed stop without a private policy capture", () => {
  const fixture = privateFixture("allow"), capturePolicyStop = vi.fn(); let failure: unknown;
  try { assertNativeResponseContinues(fixture.message, { stage: "query", capturePolicyStop }); }
  catch (error) { failure = error; }
  expect(safeNativeFailureDiagnostic(failure)).toMatchObject({ stage: "query", code: "POLICY_STOP", decision: "allow" });
  expect(capturePolicyStop).not.toHaveBeenCalled();
});

test("private capture helper independently rejects an allow receipt", () => {
  const capture = createNativePrivatePolicyCapture({ config: privateConfig, campaignSha256, artifactSha256 });
  let failure: unknown;
  try { capture({ ...privateFixture("allow"), stage: "query" }); } catch (error) { failure = error; }
  expect(safeNativeFailureDiagnostic(failure)).toEqual({ stage: "query", code: "PRIVATE_POLICY_CAPTURE_FAILED" });
});

test("fsynced encrypted receipt survives the policy exception and natural child-process exit 1", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-private-exit-"));
  try {
    const moduleUrl = pathToFileURL(resolve("scripts/native-qa-diagnostics.mjs")).href;
    const code = `import { createNativePrivatePolicyCapture, assertNativeResponseContinues, safeNativeFailureDiagnostic } from ${JSON.stringify(moduleUrl)};
      let input = ''; for await (const bytes of process.stdin) input += bytes; const value = JSON.parse(input);
      const capturePolicyStop = createNativePrivatePolicyCapture(value);
      try { assertNativeResponseContinues(value.message, { stage: 'node_proposal', operation: value.operation, capturePolicyStop }); }
      catch (error) { console.log(JSON.stringify(safeNativeFailureDiagnostic(error))); process.exitCode = 1; }`;
    const child = spawn(process.execPath, ["--import", pathToFileURL(resolve("node_modules/tsx/dist/esm/index.mjs")).href, "--input-type=module", "-e", code],
      { cwd: directory, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", bytes => { output += bytes; }); child.stderr.on("data", bytes => { output += bytes; });
    const completed = new Promise<number | null>((resolveResult, reject) => { child.once("error", reject); child.once("close", resolveResult); });
    child.stdin.end(JSON.stringify({ config: privateConfig, campaignSha256, artifactSha256, ...privateFixture() }));
    expect(await completed).toBe(1); expect(output).not.toContain("RAW_SECRET_SENTINEL"); expect(output).toContain('"privatePolicyCaptured":true');
    const packet = JSON.parse(await readReport(join(directory, "dist/qa-private-policy", `${campaignSha256}.json`), "utf8"));
    expect(new FirestoreRecordCodec(privateConfig.STORAGE_ENCRYPTION_KEY, privateScope).decodeHead({ ...packet, payload: Buffer.from(packet.payload, "base64") }))
      .toMatchObject({ authenticatedSavedResponse: { receipt: { reason: "RAW_SECRET_SENTINEL original receipt" } } });
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15000);

test.each(["deny", "review", "unavailable"])("native %s policy stop preserves original safe outcome before a missing proposal is dereferenced", decision => {
  const message = { id: "msg_fixture", artifacts: { intent: "POLICY_DENIAL", policyCheck: { decision, source: "local_model", reason: "private-policy-reason", raw: "private-response" } } };
  let failure: unknown;
  try { assertNativeResponseContinues(message, { stage: "node_proposal", operationId: "chatop_fixture", chatId: "chat_fixture" }); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(NativeQaStop);
  expect(safeNativeFailureDiagnostic(failure)).toEqual({ stage: "node_proposal", decision, source: "local_model", code: "POLICY_STOP" });
  expect(JSON.stringify(safeNativeFailureDiagnostic(failure))).not.toContain("private");
});

test("policy failure code stops even without POLICY_DENIAL or blocked artifacts", () => {
  expect(() => assertNativeResponseContinues({ artifacts: { policyCheck: { decision: "deny", source: "local_model", failureCode: "LOCAL_POLICY_RESPONSE_INVALID" } } })).toThrow(NativeQaStop);
  try { assertNativeResponseContinues({ artifacts: { policyCheck: { decision: "deny", source: "local_model", failureCode: "LOCAL_POLICY_RESPONSE_INVALID" } } }); }
  catch (error) { expect(safeNativeFailureDiagnostic(error).code).toBe("LOCAL_POLICY_RESPONSE_INVALID"); }
});

test("blocked response and malformed diagnostic fields never disclose arbitrary errors, policy reason or provider payload", () => {
  const privateText = "private-credential/body/reasoning";
  expect(safeNativeFailureDiagnostic(Object.assign(new Error(privateText), { actual: privateText, cause: privateText }))).toEqual({ stage: "real_model_campaign", code: "NATIVE_ACCEPTANCE_FAILED" });
  const spoof = new NativeQaStop({ stage: privateText, operationId: privateText, code: privateText, reason: privateText, source: privateText, decision: privateText });
  expect(safeNativeFailureDiagnostic(spoof)).toEqual({ stage: "real_model_campaign", code: "NATIVE_ACCEPTANCE_FAILED" });
  expect(() => assertNativeResponseContinues({ artifacts: { blocked: true, code: privateText } })).toThrow(NativeQaStop);
});

test("allowed response continues unchanged; executable boundary suppresses raw exception rendering", async () => {
  expect(() => assertNativeResponseContinues({ artifacts: { policyCheck: { decision: "allow" } } })).not.toThrow();
  const source = await readFile("scripts/qualify-firebase-adapter.mjs", "utf8"), failure = source.slice(source.indexOf("} catch (error) {", source.indexOf("// Own the executable boundary")));
  expect(failure.indexOf("safeNativeFailureDiagnostic(error)")).toBeLessThan(failure.indexOf("await holdLocalDemo()"));
  expect(failure).not.toContain("throw error;"); expect(failure).not.toContain("console.error(error");
  expect(source).toContain("process.exitCode = 1");
});

test("report fsync failure remains a safe failed campaign, closes descriptor and cannot replace original assertion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-safe-io-")), path = join(directory, "report.jsonl");
  try {
    const report = createNativeQaReport(path), context = createNativeQaContext(report.record);
    context.stage("query");
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error("RAW_SECRET_SENTINEL"); });
    let writeFailure: unknown;
    try { context.check("TOOL_STATUS", () => assert.fail("original not reached")); } catch (error) { writeFailure = error; }
    expect(safeNativeFailureDiagnostic(writeFailure).code).toBe("REPORT_WRITE_FAILED");
    expect(() => report.finish(true)).toThrow(NativeQaStop);
    expect(closeSync).toHaveBeenCalled();
    expect(JSON.stringify(writeFailure)).not.toContain("RAW_SECRET_SENTINEL");
    const contextWithFailingRecorder = createNativeQaContext((record: { event: string }) => { if (record.event === "failed") throw new Error("RAW_SECRET_SENTINEL"); });
    contextWithFailingRecorder.stage("query");
    let assertionFailure: unknown;
    try { contextWithFailingRecorder.check("TOOL_STATUS", () => assert.equal("bad", "SUCCEEDED")); } catch (error) { assertionFailure = error; }
    expect(safeNativeFailureDiagnostic(assertionFailure)).toMatchObject({ check: "TOOL_STATUS", code: "NATIVE_ASSERTION_FAILED" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("report close failure is sanitized and never returns successful completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-safe-close-")), path = join(directory, "report.jsonl");
  try {
    const report = createNativeQaReport(path), actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(closeSync).mockImplementationOnce(descriptor => { actual.closeSync(descriptor); throw new Error("RAW_SECRET_SENTINEL"); });
    let failure: unknown;
    try { report.finish(true); } catch (error) { failure = error; }
    expect(safeNativeFailureDiagnostic(failure)).toEqual({ stage: "real_model_campaign", code: "REPORT_CLOSE_FAILED" });
    expect(JSON.stringify(failure)).not.toContain("RAW_SECRET_SENTINEL");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("diagnostic getters and spoofed exception fields are never evaluated", () => {
  const getter = vi.fn(() => { throw new Error("RAW_SECRET_SENTINEL"); });
  const hostile = Object.defineProperties({}, Object.fromEntries(["stage", "check", "code", "operationStatus", "rowCount", "diagnostic"].map(key => [key, { get: getter }])));
  expect(safeNativeFailureDiagnostic(hostile)).toEqual({ stage: "real_model_campaign", code: "NATIVE_ACCEPTANCE_FAILED" });
  expect(JSON.stringify(new NativeQaStop(hostile))).not.toContain("RAW_SECRET_SENTINEL");
  const context = createNativeQaContext();
  expect(() => context.check("TOOL_STATUS", () => {}, hostile)).not.toThrow();
  expect(getter).not.toHaveBeenCalled();
});

test.each(["QUEUED", "RUNNING", "ANSWERED", "FAILED", "CANCELLED", "RECOVERY_REQUIRED"])("exact repository operation status is safe: %s", operationStatus => {
  expect(safeNativeFailureDiagnostic(new NativeQaStop({ stage: "query", check: "TERMINAL_RESPONSE", code: "NATIVE_ASSERTION_FAILED", operationStatus })))
    .toMatchObject({ operationStatus });
});

test("invented operation/tool statuses and unbounded counters are omitted", () => {
  expect(safeNativeFailureDiagnostic(new NativeQaStop({ stage: "query", code: "NATIVE_ASSERTION_FAILED", operationStatus: "ABANDONED", toolStatus: "RUNNING", rowCount: Infinity, pollCount: -1 })))
    .toEqual({ stage: "query", code: "NATIVE_ASSERTION_FAILED" });
});

test.each(["adapter", "inspector"])("%s executable suppresses raw error/input/path text and exits 1 before external work", async kind => {
  const secret = "RAW_SECRET_SENTINEL", directory = await mkdtemp(join(tmpdir(), `${secret}-`));
  try {
    const script = resolve(`scripts/${kind === "adapter" ? "qualify-firebase-adapter" : "native-functions-real-model-qa"}.mjs`);
    const child = spawn(process.execPath, ["--import", pathToFileURL(resolve("node_modules/tsx/dist/esm/index.mjs")).href, script, kind === "adapter" ? "--cleanup" : "--inspect"],
      { cwd: directory, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GENERATION_API_KEY: secret } });
    let output = "";
    child.stdout.on("data", bytes => { output += bytes.toString("utf8"); }); child.stderr.on("data", bytes => { output += bytes.toString("utf8"); });
    const completed = new Promise<number | null>((resolveResult, reject) => { child.once("error", reject); child.once("close", resolveResult); });
    child.stdin.end(kind === "inspector" ? secret : "");
    expect(await completed).toBe(1);
    expect(output).not.toContain(secret);
    expect(output).toContain(kind === "adapter" ? "Native campaign failure diagnostic:" : "Fresh real-model storage inspector refused or failed; details suppressed");
    expect(output).not.toContain("AssertionError");
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15000);

test.each(["TASK_DISPATCH", "MODEL_BINDING", "TERMINAL_RESPONSE", "SAVED_MESSAGE", "SAVED_MODEL", "POLICY_SOURCE", "POLICY_FALLBACK", "POLICY_DECISION", "TOOL_STATUS", "ROW_COUNT"])("named original assertion remains a failure: %s", check => {
  const context = createNativeQaContext(); context.stage("query");
  let failure: unknown;
  try { context.check(check, () => assert.equal("RAW_SECRET_SENTINEL", "expected"), { operationStatus: "FAILED", rowCount: 7 }); }
  catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(NativeQaStop);
  expect(safeNativeFailureDiagnostic(failure)).toEqual({ stage: "query", check, code: "NATIVE_ASSERTION_FAILED", operationStatus: "FAILED", rowCount: 7 });
  expect(JSON.stringify(failure)).not.toContain("RAW_SECRET_SENTINEL");
  expect(String(failure)).not.toContain("RAW_SECRET_SENTINEL");
});

test("arbitrary errors and valid-looking returned IDs never become diagnostics", async () => {
  const secret = "RAW_SECRET_SENTINEL", events: unknown[] = [], context = createNativeQaContext((event: unknown) => events.push(event));
  context.stage("query");
  const hostile = Object.assign(new Error(secret), { stage: "query", code: "TOOL_STATUS", status: secret, actual: secret, expected: secret, cause: secret,
    operationId: `chatop_${secret}`, chatId: `chat_${secret}`, messageId: `msg_${secret}` });
  await expect(context.step("HTTP_RESPONSE", async () => { throw hostile; })).rejects.toBeInstanceOf(NativeQaStop);
  expect(JSON.stringify(events)).not.toContain(secret);
  expect(JSON.stringify(context.failure(hostile))).not.toContain(secret);
  const stop = new NativeQaStop({ ...hostile, operationStatus: secret, toolStatus: secret, httpStatus: secret, rowCount: secret });
  expect(JSON.stringify(safeNativeFailureDiagnostic(stop))).not.toContain(secret);
  expect(JSON.stringify(safeNativeFailureDiagnostic(stop))).not.toMatch(/operationId|chatId|messageId/);
});

test("durable exclusive report contains only safe fixed fields and retains first failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-safe-report-")), path = join(directory, "report.jsonl"), secret = "RAW_SECRET_SENTINEL";
  try {
    const report = createNativeQaReport(path), context = createNativeQaContext(report.record);
    context.stage("query");
    let failure: unknown;
    try { context.check("TOOL_STATUS", () => assert.equal(secret, "SUCCEEDED"), { toolStatus: secret, rowCount: 7, chatId: `chat_${secret}`, body: secret }); }
    catch (error) { failure = error; }
    report.finish(false, context.failure(failure));
    expect(() => createNativeQaReport(path)).toThrow(NativeQaStop);
    const bytes = await readReport(path, "utf8"), records = bytes.trim().split("\n").map(line => JSON.parse(line));
    expect(bytes).not.toContain(secret);
    expect(records.at(-1)).toMatchObject({ event: "failed", diagnostic: { stage: "query", check: "TOOL_STATUS", code: "NATIVE_ASSERTION_FAILED", rowCount: 7 } });
    expect(records.map(record => record.sequence)).toEqual(records.map((_, index) => index + 1));
    expect(await readReport(path, "utf8")).toBe(bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

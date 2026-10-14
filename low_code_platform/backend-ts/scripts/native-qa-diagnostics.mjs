import { openSync, writeSync, fsyncSync, closeSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { FirestoreRecordCodec } from "../src/storage/firestore-record-codec.js";

const decisions = new Set(["allow", "deny", "review", "unavailable"]);
const sources = new Set(["local_model", "erpbridge", "skipped"]);
const failureCodes = new Set(["LOCAL_POLICY_CONFIG_INVALID", "LOCAL_POLICY_PROVIDER_FAILED", "LOCAL_POLICY_RESPONSE_INVALID", "POLICY_CHECK_CANCELLED"]);
const stages = new Set(["adapter_setup", "provider_setup", "query", "generate", "node_proposal", "apply", "publish", "run", "postrun_query", "durability", "inspector", "real_model_campaign"]);
const checks = new Set([
  "SCOPE", "NODE_VERSION", "HTTP_RESPONSE", "HTTP_CREDENTIAL_FILTER", "HTTP_STATUS", "PROVIDER_TEST", "CHAT_CREATE",
  "TASK_DISPATCH", "MODEL_BINDING", "TERMINAL_RESPONSE", "SAVED_MESSAGE", "SAVED_MODEL", "POLICY_CONTINUES",
  "POLICY_SOURCE", "POLICY_FALLBACK", "POLICY_DECISION", "TOOL_STATUS", "ROW_COUNT", "DRAFT_SAVED", "UNPUBLISHED",
  "STEP_COUNT", "STEP_ACTION", "READINESS", "PROPOSAL_STATUS", "PROPOSAL_UNAPPLIED", "EDIT_VERSION", "EDIT_DESCRIPTION",
  "EDIT_EXACT", "RUN_TERMINAL", "RUN_ROWS", "RUN_IDEMPOTENCY", "STATUS_PROFILE", "STATUS_RECORD", "STATUS_HEADING",
  "STATUS_TEXT", "STATUS_INTERPRETATION", "NO_EMAIL", "CHECKPOINT_READ", "REFERENCE_ID", "CHECKPOINT_RECORDS",
  "CHAT_LINK", "RUN_LINK", "DRAFT_VERSION", "PUBLISHED_VERSION", "SNAPSHOT_VERSION", "APPLIED_COUNT",
  "INSPECTOR_INPUT", "INSPECTOR_START", "INSPECTOR_EXIT", "INSPECTOR_JSON", "INSPECTOR_PID", "INSPECTOR_DISTINCT_PID",
  "INSPECTOR_FIRST", "INSPECTOR_SECOND", "INSPECTOR_CHECKPOINT", "SOURCE_UNCHANGED", "OUTPUTS_UNCHANGED", "BROWSER_ORIGINS",
]);
const codes = new Set([...failureCodes, "POLICY_STOP", "RESPONSE_BLOCKED", "PRIVATE_POLICY_CAPTURE_FAILED", "NATIVE_ACCEPTANCE_FAILED", "NATIVE_ASSERTION_FAILED", "CHECK_PENDING", "CHECK_PASSED", "REPORT_OPEN_FAILED", "REPORT_WRITE_FAILED", "REPORT_CLOSE_FAILED"]);
const operationStatuses = new Set(["QUEUED", "RUNNING", "ANSWERED", "FAILED", "CANCELLED", "RECOVERY_REQUIRED"]);
const toolStatuses = new Set(["SUCCEEDED", "FAILED"]);
const events = new Set(["started", "stage", "checking", "passed", "failed", "succeeded"]);
// Own data fields only: getters, proxies, raw errors and returned IDs are never
// trusted as diagnostic content. Original exceptions stay in this private map.
const privateFailures = new WeakMap();
const own = (value, key) => { try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; } };
const safeDiagnostic = value => {
  const stage = own(value, "stage"), check = own(value, "check"), code = own(value, "code");
  const result = { stage: stages.has(stage) ? stage : "real_model_campaign", ...(checks.has(check) ? { check } : {}), code: codes.has(code) ? code : "NATIVE_ACCEPTANCE_FAILED" };
  for (const [key, allowed] of [["decision", decisions], ["source", sources], ["operationStatus", operationStatuses], ["toolStatus", toolStatuses]]) {
    const field = own(value, key); if (allowed.has(field)) result[key] = field;
  }
  for (const key of ["httpStatus", "expectedHttpStatus", "pollCount", "rowCount", "expectedRows"]) {
    const field = own(value, key); if (Number.isSafeInteger(field) && field >= 0 && field <= 1000000) result[key] = field;
  }
  const fallbackUsed = own(value, "fallbackUsed"); if (typeof fallbackUsed === "boolean") result.fallbackUsed = fallbackUsed;
  const captured = own(value, "privatePolicyCaptured"); if (typeof captured === "boolean") result.privatePolicyCaptured = captured;
  for (const key of ["policyHash", "ciphertextSha256"]) { const field = own(value, key); if (typeof field === "string" && /^[a-f0-9]{64}$/.test(field)) result[key] = field; }
  if (own(value, "promptTemplateVersion") === "prompt/local-policy/v2") result.promptTemplateVersion = "prompt/local-policy/v2";
  return result;
};

export class NativeQaStop extends Error {
  constructor(diagnostic, original) {
    super("Native campaign stopped; private exception details suppressed");
    this.name = "NativeQaStop";
    const safe = Object.freeze(safeDiagnostic(diagnostic));
    Object.defineProperty(this, "diagnostic", { value: safe, enumerable: true });
    privateFailures.set(this, { diagnostic: safe, original });
  }
}

/** Never dereference a missing proposal after a saved policy-stop receipt. */
export function assertNativeResponseContinues(message, { stage, capturePolicyStop, operation, nodeContext } = {}) {
  const artifacts = own(message, "artifacts"), policy = own(artifacts, "policyCheck");
  if (own(artifacts, "intent") !== "POLICY_DENIAL" && !own(artifacts, "blocked") &&
      !own(policy, "failureCode") && (!policy || own(policy, "decision") === "allow")) return;
  let capture;
  const policyStop = ["deny", "review", "unavailable"].includes(own(policy, "decision")) || failureCodes.has(own(policy, "failureCode"));
  if (capturePolicyStop && policyStop) {
    try { capture = capturePolicyStop({ stage, operation, message, nodeContext });
      if (own(capture, "privatePolicyCaptured") !== true) throw new Error("Private capture was not confirmed");
    } catch (error) { throw new NativeQaStop({ stage, code: "PRIVATE_POLICY_CAPTURE_FAILED" }, error); }
  }
  throw new NativeQaStop({ stage, decision: own(policy, "decision"), source: own(policy, "source"), fallbackUsed: own(policy, "fallbackUsed"),
    promptTemplateVersion: own(policy, "promptTemplateVersion"), policyHash: own(policy, "policyHash"),
    privatePolicyCaptured: own(capture, "privatePolicyCaptured"), ciphertextSha256: own(capture, "ciphertextSha256"),
    code: failureCodes.has(own(policy, "failureCode")) ? own(policy, "failureCode") : own(artifacts, "intent") === "POLICY_DENIAL" ? "POLICY_STOP" : "RESPONSE_BLOCKED" });
}

/** Private bounded receipt only; reuses the original QA session key, never stores it. */
export function createNativePrivatePolicyCapture({ config, campaignSha256, artifactSha256 }) {
  return ({ stage, operation, message, nodeContext }) => {
    let descriptor;
    try {
      const requireValue = condition => { if (!condition) throw new Error("Invalid bounded private policy evidence"); };
      const hex = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
      const text = (value, maximum) => typeof value === "string" && value.length > 0 && value.length <= maximum;
      requireValue(hex(campaignSha256) && hex(artifactSha256) && stages.has(stage));
      const namespace = { projectId: own(config, "FIRESTORE_PROJECT_ID"), databaseId: own(config, "FIRESTORE_DATABASE_ID"), workspaceId: own(config, "FIRESTORE_WORKSPACE_ID") };
      requireValue(namespace.projectId === "demo-lcwe-records" && namespace.databaseId === "(default)" && /^test_[a-f0-9]{32}_native$/.test(namespace.workspaceId));
      const codec = new FirestoreRecordCodec(own(config, "STORAGE_ENCRYPTION_KEY"), namespace);
      const operationId = own(operation, "id"), messageId = own(message, "id"), policy = own(own(message, "artifacts"), "policyCheck");
      requireValue(text(operationId, 128) && text(messageId, 128) && own(operation, "status") === "ANSWERED" && own(operation, "assistantMessageId") === messageId &&
        (own(message, "operationId") === undefined || own(message, "operationId") === operationId));
      const receipt = {};
      for (const [key, allowed] of [["decision", decisions], ["source", sources]]) { const field = own(policy, key); requireValue(allowed.has(field)); receipt[key] = field; }
      for (const [key, maximum] of [["reason", 1000], ["policyVersion", 128], ["model", 256]]) {
        const field = own(policy, key); if (key === "reason" || field !== undefined) { requireValue(text(field, maximum)); receipt[key] = field; }
      }
      for (const [key, valid] of [["policyHash", hex], ["promptTemplateVersion", value => value === "prompt/local-policy/v2"],
        ["failureCode", value => failureCodes.has(value)], ["fallbackUsed", value => typeof value === "boolean"]]) {
        const field = own(policy, key); if (field !== undefined) { requireValue(valid(field)); receipt[key] = field; }
      }
      requireValue(["deny", "review", "unavailable"].includes(receipt.decision) || failureCodes.has(receipt.failureCode));
      const originalHarnessRequest = { profile: "native-harness-request-context/v1", serverPolicyContextVerified: false };
      if (nodeContext !== undefined) {
        const context = {};
        for (const key of ["workflowId", "nodeId", "baseHash"]) { const field = own(nodeContext, key); requireValue(text(field, 128)); context[key] = field; }
        const baseVersion = own(nodeContext, "baseVersion"); requireValue(Number.isSafeInteger(baseVersion) && baseVersion >= 1); context.baseVersion = baseVersion;
        originalHarnessRequest.nodeContext = context;
      }
      const document = codec.encodeHead({ profile: "native-private-policy-stop/v1", purpose: "original-saved-policy-receipt-diagnosis",
        campaignSha256, artifactSha256, stage, authenticatedSavedResponse: { operationId, messageId, receipt }, originalHarnessRequest });
      const bytes = Buffer.from(JSON.stringify({ profile: document.profile, payload: document.payload.toString("base64") }) + "\n");
      const directory = resolve("dist/qa-private-policy"); mkdirSync(directory, { recursive: true, mode: 0o700 });
      descriptor = openSync(resolve(directory, `${campaignSha256}.json`), "wx", 0o600);
      let written = 0;
      while (written < bytes.length) { const count = writeSync(descriptor, bytes, written, bytes.length - written); requireValue(count > 0); written += count; }
      fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
      return { privatePolicyCaptured: true, ciphertextSha256: createHash("sha256").update(bytes).digest("hex") };
    } catch (error) {
      if (descriptor !== undefined) { try { closeSync(descriptor); } catch {} }
      throw new NativeQaStop({ stage, code: "PRIVATE_POLICY_CAPTURE_FAILED" }, error);
    }
  };
}

/** Never inspect arbitrary exception text/actual/expected/cause/diagnostic. */
export function safeNativeFailureDiagnostic(error) {
  return privateFailures.get(error)?.diagnostic ?? { stage: "real_model_campaign", code: "NATIVE_ACCEPTANCE_FAILED" };
}

/** A wrapper labels the original assertion; it never replaces its predicate. */
export function createNativeQaContext(record = () => {}) {
  let current = { stage: "adapter_setup", code: "CHECK_PENDING" };
  const failure = error => privateFailures.get(error)?.diagnostic ?? safeDiagnostic({ ...current, code: "NATIVE_ACCEPTANCE_FAILED" });
  const emit = event => record({ event, diagnostic: current });
  const begin = (check, observations) => { current = safeDiagnostic({ ...safeDiagnostic(observations), stage: current.stage, check, code: "CHECK_PENDING" }); emit("checking"); };
  const reject = (error, code = "NATIVE_ASSERTION_FAILED") => {
    const diagnostic = privateFailures.get(error)?.diagnostic;
    // Preserve policy-specific outcomes, otherwise label the original failure.
    const stopped = new NativeQaStop(diagnostic ? { ...diagnostic, check: current.check } : { ...current, code }, error);
    current = stopped.diagnostic;
    try { emit("failed"); } catch { /* A report failure must not replace the original failed assertion. */ }
    throw stopped;
  };
  return {
    stage(stage) { current = safeDiagnostic({ stage, code: "CHECK_PENDING" }); emit("stage"); },
    check(check, assertion, observations = {}) {
      begin(check, observations);
      let result; try { result = assertion(); } catch (error) { reject(error); }
      current = safeDiagnostic({ ...current, code: "CHECK_PASSED" }); emit("passed"); return result;
    },
    async step(check, work, observations = {}) {
      begin(check, observations);
      let result; try { result = await work(); } catch (error) { reject(error, "NATIVE_ACCEPTANCE_FAILED"); }
      current = safeDiagnostic({ ...current, code: "CHECK_PASSED" }); emit("passed"); return result;
    },
    failure,
  };
}

/** Exclusive append-only evidence, fsynced per record; never overwrites a run. */
export function createNativeQaReport(path, { artifactSha256 } = {}) {
  let descriptor, sequence = 0, closed = false, broken = false;
  const createdAt = new Date().toISOString();
  const metadata = typeof artifactSha256 === "string" && /^[a-f0-9]{64}$/.test(artifactSha256) ? { artifactSha256 } : {};
  try { descriptor = openSync(path, "wx", 0o600); }
  catch (error) { throw new NativeQaStop({ code: "REPORT_OPEN_FAILED" }, error); }
  const record = value => {
    if (closed || broken) throw new NativeQaStop({ code: "REPORT_WRITE_FAILED" });
    const event = own(value, "event"), diagnostic = safeDiagnostic(own(value, "diagnostic"));
    const bytes = Buffer.from(JSON.stringify({ profile: "native-real-model-safe-report/v1", createdAt, ...metadata, sequence: ++sequence, event: events.has(event) ? event : "failed", diagnostic }) + "\n");
    try {
      let written = 0;
      while (written < bytes.length) { const count = writeSync(descriptor, bytes, written, bytes.length - written); if (count <= 0) throw new Error("Report write made no progress"); written += count; }
      fsyncSync(descriptor);
    } catch (error) { broken = true; throw new NativeQaStop({ code: "REPORT_WRITE_FAILED" }, error); }
  };
  try { record({ event: "started" }); }
  catch (error) { try { closeSync(descriptor); } catch {} closed = true; throw error; }
  return {
    record,
    finish(passed, diagnostic) {
      let failure;
      try { record({ event: passed === true ? "succeeded" : "failed", diagnostic }); } catch (error) { failure = error; }
      if (!closed) { closed = true; try { closeSync(descriptor); } catch (error) { failure ??= new NativeQaStop({ code: "REPORT_CLOSE_FAILED" }, error); } }
      if (failure) throw failure;
    },
  };
}

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { canonicalJSONBytes, resolvedParameterHashBytes } from "../core/canonical-json.js";
import { boundedFiniteJSONBytes } from "../core/bounded-finite-json.js";
import { decodeEncryptionKey } from "../storage/aes-gcm.js";
import type { RepositoryState, StoredRecord } from "../repository/store.js";
import { HandlerFailure, appendAudit, nextID, validateWorkflow, type HandlerServices, type CurrentUser } from "../http/handlers/common.js";
import { workflowContentHash, parseWorkflowYAMLStrict } from "../parser/workflow.js";
import { requireWorkflowBase } from "./commands.js";
import { savedDraftHistory } from "./draft-history.js";
import { savedGeneratedReturnCoverageIssues } from "../synthesis/return-coverage.js";
import { prepareProtectedOperationCompilation, protectedOperationPublicationCandidate, protectedOperationRuntimeBindings } from "./protected-operation-preparation.js";
import { captureProtectedOperationPlan, protectedOperationConnections } from "./protected-operation-bindings.js";
import { publicWorkflowVersion } from "./public-workflow-version.js";
import type { CompiledProtectedOperationPlan } from "./protected-operation-compiler.js";

const hash = (value: unknown) => resolvedParameterHashBytes(canonicalJSONBytes(value));
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/), id = z.string().min(1).max(256);
const receiptSchema = z.object({ profile: z.literal("protected-operation-publication/v1"), workflowId: id, versionId: id,
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1), sourceHash: digest, semanticHash: digest, machineHash: digest,
  registryHash: digest, verifiedRole: id, bindingHash: digest, runtimeQualified: z.literal(false) }).strict();
export type ProtectedOperationPublicationReceipt = z.infer<typeof receiptSchema>;
type Candidate = ReturnType<typeof protectedOperationPublicationCandidate>;
type DurableBindings = Pick<Candidate, "connections" | "models" | "approvalPolicy"> & { providerBinding?: string; governanceHash: string };
type PublicationBody = { receipt: ProtectedOperationPublicationReceipt; plan: CompiledProtectedOperationPlan;
  publisherContext: Candidate["publisherContext"]; createdAt: string; createdBy: { id: string; name: string }; bindings: DurableBindings };
const bodySchema = z.object({ receipt: receiptSchema, plan: z.unknown(),
  publisherContext: z.object({ workflowId: id, baseVersion: z.number().int().min(1), sourceHash: digest, actorId: id, roleId: id,
    role: id, departmentId: z.string().nullable(), permissionHash: digest, aclHash: digest, registryHash: digest }).strict(),
  createdAt: z.string().datetime(), createdBy: z.object({ id, name: z.string().max(256) }).strict(),
  bindings: z.object({ connections: z.array(z.object({ id, admissionBinding: z.string().min(1).max(4096), roleMapHash: digest }).strict()).min(1).max(100),
    models: z.array(z.object({ nodeId: id, kind: z.enum(["analysis", "agent"]), providerId: id, model: id }).strict()).max(100),
    approvalPolicy: digest.optional(), providerBinding: digest.optional(), governanceHash: digest }).strict() }).strict();
const secretSchema = z.object({ body: bodySchema, seal: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
function deny(message = "Protected publication is missing, changed or no longer matches current reviewed configuration; review and republish"): never {
  throw new HandlerFailure(409, message, { code: "PROTECTED_PUBLICATION_REQUIRED" });
}
function mac(services: HandlerServices, domain: string, value: unknown): string {
  return createHmac("sha256", decodeEncryptionKey(services.config.storageEncryptionKey)).update(domain).update("\0").update(canonicalJSONBytes(value)).digest("hex");
}
function scope(services: HandlerServices) {
  const config = services.config;
  if (config.storageDriver.startsWith("firestore") && (!config.firestoreProjectId || !config.firestoreDatabaseId || !config.firestoreWorkspaceId))
    deny("Protected publication requires an exact configured Firestore namespace");
  return { driver: config.storageDriver, application: config.appName,
    ...(config.storageDriver.startsWith("firestore") ? { project: config.firestoreProjectId, database: config.firestoreDatabaseId, workspace: config.firestoreWorkspaceId } : {}),
    ...(config.storageDriver.startsWith("postgres") ? { databaseBinding: mac(services, "protected-publication-database/v1", config.databaseURL) } : {}) };
}
function seal(services: HandlerServices, body: PublicationBody) { return mac(services, "protected-publication-seal/v1", { scope: scope(services), body }); }
export function protectedPublicationWorkspaceBinding(services: HandlerServices): string { return mac(services, "protected-publication-workspace/v1", scope(services)); }
function providerBinding(services: HandlerServices, hasModels: boolean): string | undefined {
  if (!hasModels) return undefined;
  const config = services.providerRuntime?.configuration;
  if (!config) deny("Protected publication requires its currently configured provider");
  // Credentials are part of the private keyed preimage, never stored or exposed.
  // Re-activating identical configuration after restart keeps this binding.
  return `sha256:${mac(services, "protected-publication-provider/v1", config)}`;
}
function bindings(services: HandlerServices, state: Readonly<RepositoryState>, candidate: Pick<Candidate, "connections" | "models" | "approvalPolicy">): DurableBindings {
  const provider = providerBinding(services, candidate.models.length > 0);
  return { connections: candidate.connections, models: candidate.models, ...(candidate.approvalPolicy ? { approvalPolicy: candidate.approvalPolicy } : {}),
    ...(provider ? { providerBinding: provider } : {}), governanceHash: hash(state.governancePolicy) };
}
function authenticate(services: HandlerServices, version: StoredRecord): PublicationBody {
  boundedFiniteJSONBytes(version.protectedCompilationSecret, 7_000_000, 262144);
  const parsed = secretSchema.parse(version.protectedCompilationSecret);
  // The authenticated plan is finite JSON, including when read through an
  // execution transaction's read-only proxies. Keep downstream compilation
  // isolated from those proxies without weakening MAC or exact-version checks.
  const body = JSON.parse(canonicalJSONBytes(parsed.body).toString("utf8")) as PublicationBody;
  const expected = seal(services, body);
  if (!timingSafeEqual(Buffer.from(parsed.seal, "hex"), Buffer.from(expected, "hex")) ||
      !canonicalJSONBytes(version.protectedCompilation).equals(canonicalJSONBytes(body.receipt)) ||
      version.id !== body.receipt.versionId || version.workflowId !== body.receipt.workflowId || version.version !== body.receipt.version ||
      version.artifactState !== "PUBLISHED" || version.executionReadiness !== "COMPILED_PROTECTED_RUNTIME_PENDING" || version.compiledRead || version.compiledOperation ||
      typeof version.yaml !== "string" || workflowContentHash(version.yaml) !== body.receipt.sourceHash ||
      version.contentHash !== body.receipt.sourceHash || version.createdAt !== body.createdAt ||
      !canonicalJSONBytes(version.createdBy).equals(canonicalJSONBytes(body.createdBy)) ||
      body.publisherContext.workflowId !== body.receipt.workflowId || body.publisherContext.sourceHash !== body.receipt.sourceHash ||
      body.publisherContext.registryHash !== body.receipt.registryHash || body.publisherContext.role !== body.receipt.verifiedRole ||
      body.publisherContext.actorId !== body.createdBy.id || body.publisherContext.baseVersion > body.receipt.version) deny();
  return body;
}

/** Historical sealed definitions only. Allows truthful stop/recovery when
 * current actor/review/provider authority was revoked; NEVER execution grant. */
export function authenticatedProtectedOperationPublication(state: Readonly<RepositoryState>, services: HandlerServices, workflowId: string, versionId: string) {
  try {
    const matches = (state.versions[workflowId] ?? []).filter(value => value.id === versionId);
    if (matches.length !== 1) deny();
    const body = authenticate(services, matches[0]!);
    return structuredClone({ plan: body.plan, receipt: body.receipt });
  } catch { deny(); }
}

/** Authoritative internal publication lifecycle for the future qualified v9
 * worker. NOT wired to normal HTTP while per-invocation execution is pending.
 * It commits immutable reviewed definitions, never run/approval/SDK authority.
 * The workflow remains canRun=false, even after successful publication. */
export async function publishProtectedOperation(services: HandlerServices, workflowId: string, user: CurrentUser,
  base: { baseVersion: number; baseHash: string; versionNote?: string }): Promise<StoredRecord> {
  if (!Number.isSafeInteger(base.baseVersion) || base.baseVersion < 1 || !/^sha256:[a-f0-9]{64}$/.test(base.baseHash) ||
      base.versionNote !== undefined && (typeof base.versionNote !== "string" || base.versionNote.length > 2000))
    throw new HandlerFailure(400, "Invalid protected publication revision");
  if (services.repository.persistence && services.repository.persistence.readQueueDurability !== "encrypted-single-writer")
    throw new HandlerFailure(503, "Protected publication requires supported single-writer storage", { code: "PROTECTED_PUBLICATION_STORAGE_UNSUPPORTED" });
  const prepared = await prepareProtectedOperationCompilation(services, workflowId, user, "publication");
  const signingBinding = mac(services, "protected-publication-signing-context/v1", scope(services));
  const initial = await services.repository.readAuthoritative(state => {
    protectedOperationPublicationCandidate(prepared, services, state, user);
    const workflow = state.workflows[workflowId]!; requireWorkflowBase(workflow, base.baseVersion, base.baseHash);
    if (workflow.status === "draft-unvalidated" || savedGeneratedReturnCoverageIssues(workflow).length)
      throw new HandlerFailure(422, "Protected workflow must pass validation and generated return coverage before publication");
    return { yaml: workflow.yaml, governanceHash: hash(state.governancePolicy) };
  });
  const validator = services.validator, validationGate = services.validationGate;
  const gate = await validateWorkflow(services, "PublishWorkflow", initial.yaml, user, { workflowId });
  if (!gate.result.passed || !gate.token || !validator.verifyToken(gate.token) || gate.token.workflow_content_hash !== base.baseHash || gate.token.registry_hash !== prepared.registryHash)
    throw new HandlerFailure(422, "Protected workflow validation failed", { code: "PROTECTED_PUBLICATION_VALIDATION_REQUIRED" });
  try {
    return await services.repository.mutate(state => {
      const candidate = protectedOperationPublicationCandidate(prepared, services, state, user), item = state.workflows[workflowId]!;
      requireWorkflowBase(item, base.baseVersion, base.baseHash);
      if (services.validator !== validator || services.validationGate !== validationGate || !validator.verifyToken(gate.token) ||
          hash(state.governancePolicy) !== initial.governanceHash ||
          signingBinding !== mac(services, "protected-publication-signing-context/v1", scope(services))) deny("Governance, signing namespace or validation context changed during protected publication");
      if (item.status === "draft-unvalidated" || savedGeneratedReturnCoverageIssues(item).length) deny("Protected draft validation or return coverage changed");
      const durable = bindings(services, state, candidate), bindingHash = hash(durable), editHistory = savedDraftHistory(state, item);
      const previous = (state.versions[workflowId] ?? []).findLast(value => value.version === item.draftVersion && value.artifactState === "PUBLISHED");
      if (previous) {
        if (previous.protectedCompilationSecret) {
          const old = authenticate(services, previous);
          if (previous.yaml === item.yaml && old.receipt.bindingHash === bindingHash && old.receipt.registryHash === prepared.registryHash &&
              old.receipt.semanticHash === prepared.semanticHash && old.receipt.machineHash === prepared.machineHash && old.receipt.verifiedRole === user.role) {
            item.canRun = false;
            return publicWorkflowVersion(previous);
          }
        }
        item.draftVersion = Math.max(item.draftVersion, item.publishedVersion) + 1;
      }
      const versionId = nextID(state, "ver"), createdAt = new Date().toISOString();
      const receipt = receiptSchema.parse({ profile: "protected-operation-publication/v1", workflowId, versionId, version: item.draftVersion,
        sourceHash: prepared.sourceHash, semanticHash: prepared.semanticHash, machineHash: prepared.machineHash, registryHash: prepared.registryHash,
        verifiedRole: user.role, bindingHash, runtimeQualified: false });
      const body: PublicationBody = { receipt, plan: candidate.plan, publisherContext: candidate.publisherContext,
        createdAt, createdBy: { id: user.id, name: user.name }, bindings: durable };
      bodySchema.parse(body); boundedFiniteJSONBytes(body, 6_900_000, 262144);
      const value: StoredRecord = { id: versionId, workflowId, version: item.draftVersion, artifactState: "PUBLISHED", versionNote: base.versionNote ?? "", yaml: item.yaml,
        contentHash: prepared.sourceHash, createdAt, createdBy: body.createdBy, protectedCompilation: receipt,
        protectedCompilationSecret: { body, seal: seal(services, body) }, ...(editHistory ? { editHistory } : {}), executionReadiness: "COMPILED_PROTECTED_RUNTIME_PENDING" };
      (state.versions[workflowId] ??= []).push(value);
      item.publishedVersion = item.draftVersion; item.canRun = false; item.updatedAt = createdAt;
      appendAudit(state, user, "workflow.protected_published_runtime_pending", "workflow", workflowId, null,
        { version: item.publishedVersion, contentHash: receipt.sourceHash, semanticHash: receipt.semanticHash, runtimeQualified: false });
      return publicWorkflowVersion(value);
    });
  } catch (error) {
    if (error instanceof HandlerFailure) throw error;
    throw new HandlerFailure(503, "Protected publication was not confirmed. Reload saved versions before attempting publication again", { code: "PROTECTED_PUBLICATION_UNCONFIRMED" });
  }
}

/** Revalidate a stored immutable publication against current contracts and
 * stable configuration. Historical publisher authority is NOT future runner
 * authority. Caller still requires fresh discovery, actor/ACL/run admission,
 * provider/session generation capture, worker ownership and final SDK guards. */
export function assertStoredProtectedOperationPublicationCurrent(state: Readonly<RepositoryState>, services: HandlerServices, versionId: string,
  workflowId: string, role: string): CompiledProtectedOperationPlan {
  try {
    const matches = (state.versions[workflowId] ?? []).filter(value => value.id === versionId);
    if (matches.length !== 1) deny();
    const version = matches[0]!, body = authenticate(services, version), receipt = body.receipt;
    if (receipt.workflowId !== workflowId || receipt.verifiedRole !== role || receipt.registryHash !== services.registries.hash()) deny();
    const yaml = String(version.yaml), source = parseWorkflowYAMLStrict(yaml);
    const plan = captureProtectedOperationPlan(state, services, source, yaml, role, body.plan);
    if (plan.sourceHash !== receipt.sourceHash || plan.semanticHash !== receipt.semanticHash || plan.machine.semanticHash !== receipt.machineHash) deny();
    const currentConnections = protectedOperationConnections(services, source).map(value => ({ id: value.id, admissionBinding: value.admissionBinding, roleMapHash: hash(value.roleMap) }));
    // Derive current model/approval eligibility via the same preparation checks
    // below; the durable hash alone cannot establish execution eligibility.
    const current = currentProtectedPublicationBindings(state, services, plan, currentConnections);
    if (hash(current) !== receipt.bindingHash || !canonicalJSONBytes(body.bindings).equals(canonicalJSONBytes(current))) deny();
    return structuredClone(plan);
  } catch { deny(); }
}

function currentProtectedPublicationBindings(state: Readonly<RepositoryState>, services: HandlerServices, plan: CompiledProtectedOperationPlan,
  connections: Candidate["connections"]): DurableBindings {
  const current = protectedOperationRuntimeBindings(state, services, plan);
  return bindings(services, state, { connections, ...current });
}

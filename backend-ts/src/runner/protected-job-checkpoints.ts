import { randomUUID } from "node:crypto";
import { stringify } from "yaml";
import type { Execution, RepositoryState } from "../repository/store.js";
import type { HandlerServices } from "../http/handlers/common.js";
import { validateWorkflow } from "../http/handlers/common.js";
import { canonicalJSONBytes } from "../core/canonical-json.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";
import type { ReadAdmissionPin, OperationNode } from "../workflows/compiled-read.js";
import type { ProtectedMachinePoint } from "../workflows/protected-machine-state.js";
import type { ProtectedBoundaryResult } from "../repository/protected-invocation-records.js";
import { validateToolInput } from "../tools/tool-input-schema.js";
import { withoutSecretFields } from "../redact/secrets.js";
import { dispatchReadTool, acknowledgedReadToolFailure } from "../tools/read-tool-broker.js";
import { appendExecutionEvent } from "./read-checkpoints.js";
import { assertProtectedDriversAvailable } from "./protected-job-admission.js";
import { protectedOperationConnections, assertProtectedConnectionsCurrent, discoverProtectedOperationConnections, assertProtectedCapabilitiesDiscovered, type ProtectedConnectionObservation } from "../workflows/protected-operation-bindings.js";
import { assertProtectedJobCurrent, restoreProtectedJob, sealProtectedCursor, protectedHash as hash, type ProtectedJobOwner } from "./protected-job-state.js";
import type { ValidationToken } from "../validator/registry-validator.js";
import { ProviderRuntime, ANALYSIS_PROMPT_VERSION } from "../providers/runtime.js";
import { assertRuntimeAnalysisEgress } from "../providers/egress-policy.js";
import { modelInputItemCount } from "../workflows/model-input.js";
import { promptData } from "../prompts/contracts.js";
import { validateValue } from "../structured-output/validate.js";
import { executeProtectedAgent, type ProtectedAgentCandidate } from "./protected-job-agent.js";
import { nextProtectedAgent } from "./protected-agent-protocol.js";

const same = (left: unknown, right: unknown) => canonicalJSONBytes(left).equals(canonicalJSONBytes(right));
type ReadNode = Extract<OperationNode, { kind: "action" }>;
type ActiveRead = { point: ProtectedMachinePoint; node: ReadNode; index: number; key: string; args: Record<string, unknown> };

/** Owned invocation worker checkpoint controller, not a deserializable permit.
 * Result/failure methods stay inside the genuine broker/provider drivers.
 * A caller can neither supply an answer nor turn a public error into a handler. */
export class ProtectedJobCheckpoints {
  readonly controller = new AbortController();
  readonly #connections: ProtectedConnectionObservation[];
  readonly #unsubscribe: () => void;
  readonly #unsubscribeProvider: (() => void) | undefined;
  readonly #owner: ProtectedJobOwner;
  readonly #governanceHash: string;
  readonly #validator: HandlerServices["validator"];
  readonly #validationGate: HandlerServices["validationGate"];
  readonly #provider: ProviderRuntime | undefined;
  readonly #providerRevision: string | undefined;
  #expiresAt = 0; #valid = true; #closed = false; #timer: NodeJS.Timeout | undefined; #token: ValidationToken | undefined;
  #read: ActiveRead | undefined;
  #analysis = false;
  #agentRead: ProtectedAgentCandidate | undefined;
  private constructor(readonly services: HandlerServices, readonly executionId: string, owner: ProtectedJobOwner, run: Execution, governanceHash: string) {
    this.#owner = owner; this.#governanceHash = governanceHash; this.#expiresAt = run.protectedJobSecret!.lease!.expiresAt;
    this.#validator = services.validator; this.#validationGate = services.validationGate;
    this.#connections = protectedOperationConnections(services, parseWorkflowYAMLStrict(run.workflowSnapshot!.yaml));
    if (parseWorkflowYAMLStrict(run.workflowSnapshot!.yaml).steps.some(step => step.kind === "analysis" || step.kind === "agent")) {
      this.#provider = services.providerRuntime; this.#providerRevision = this.#provider?.binding?.configurationRevision;
    }
    this.#unsubscribeProvider = this.#provider?.observeConfigurationChanges(() => {
      this.#valid = false; this.controller.abort(new Error("Protected provider revision changed"));
    });
    this.#unsubscribe = services.repository.observeCommits({ committed: state => {
      try {
        const current = this.current(state); this.#expiresAt = current.run.protectedJobSecret!.lease!.expiresAt;
      } catch { this.#valid = false; this.controller.abort(new Error("Protected worker authority changed")); }
    }, unavailable: () => { this.#valid = false; this.controller.abort(new Error("Protected storage authority unavailable")); } });
  }
  static async claim(services: HandlerServices, executionId: string): Promise<ProtectedJobCheckpoints | undefined> {
    const workerId = `protected-worker-${randomUUID()}`, leaseId = `lease-${randomUUID()}`;
    const claimed = await services.repository.mutateExecution(executionId, state => {
      const saved = restoreProtectedJob(state, services, executionId), { run, ledger, machine } = saved, job = run.protectedJobSecret!;
      if (["FINISHED", "RECOVERY_REQUIRED"].includes(job.state)) return undefined;
      if (job.state === "CLAIMED" && job.lease!.expiresAt > Date.now()) throw new Error("Protected run already has a current worker");
      const pending = Object.values(ledger.snapshot().intents).filter(value => value.sequence === machine.snapshot().sequence);
      // A durable entered intent is uncertain after takeover, never replayable.
      if (pending.some(value => value.state === "DISPATCH_INTENT" || value.state === "UNKNOWN")) {
        for (const item of pending) if (item.state === "DISPATCH_INTENT") ledger.unknown(machine, item.key, item.epoch);
        run.protectedInvocationSecret = ledger.snapshot(); job.state = "RECOVERY_REQUIRED"; delete job.lease;
        run.status = "RECOVERY_REQUIRED"; run.completedAt = new Date().toISOString();
        run.agentSummary = "A previous worker entered a call without confirmed completion. It was not replayed; reconciliation is required.";
        sealProtectedCursor(services, state, run, machine); appendExecutionEvent(state, run, "run.recovery_required", { reason: "UNCONFIRMED_INVOCATION" });
        return undefined;
      }
      try { assertProtectedJobCurrent(state, services, executionId); assertProtectedDriversAvailable(saved.plan); }
      catch {
        // The historical state is authentic, but revoked admission must not
        // leave a queued job frozen forever or silently borrow new authority.
        job.state = "FINISHED"; delete job.lease; run.status = run.readProgress!.cancellation ? "CANCELLED" : "FAILED";
        run.completedAt = new Date().toISOString(); run.agentSummary = "Current authority or reviewed configuration no longer permits this queued run. No call was replayed.";
        sealProtectedCursor(services, state, run, machine); appendExecutionEvent(state, run, `run.${run.status.toLowerCase()}`, { reason: "PROTECTED_ADMISSION_CONTEXT_CHANGED" });
        return undefined;
      }
      run.readProgress!.epoch++;
      for (const item of pending) if (item.state === "PREPARING") ledger.transferPrepared(machine, item.key, run.readProgress!.epoch);
      run.protectedInvocationSecret = ledger.snapshot(); run.status = "RUNNING"; job.state = "CLAIMED";
      job.lease = { id: leaseId, workerId, expiresAt: Date.now() + services.config.readWorkerLeaseMs };
      sealProtectedCursor(services, state, run, machine); appendExecutionEvent(state, run, "run.started", { profile: job.profile, epoch: run.readProgress!.epoch });
      return { run: structuredClone(run), epoch: run.readProgress!.epoch, governanceHash: hash(state.governancePolicy) };
    });
    return claimed ? new ProtectedJobCheckpoints(services, executionId, { workerId, leaseId, epoch: claimed.epoch }, claimed.run, claimed.governanceHash) : undefined;
  }
  get repository() { return this.services.repository; }
  private current(state: Readonly<RepositoryState>) {
    if (this.#provider && (this.services.providerRuntime !== this.#provider || this.#provider.binding?.configurationRevision !== this.#providerRevision))
      throw new Error("Protected provider instance or revision changed");
    const saved = assertProtectedJobCurrent(state, this.services, this.executionId, this.#owner);
    if (hash(state.governancePolicy) !== this.#governanceHash) throw new Error("Protected governance changed");
    assertProtectedConnectionsCurrent(this.services, parseWorkflowYAMLStrict(saved.run.workflowSnapshot!.yaml), this.#connections);
    return saved;
  }
  assertDispatch(): void {
    this.repository.assertAuthority();
    if (this.services.validator !== this.#validator || this.services.validationGate !== this.#validationGate) throw new Error("Protected validation services changed");
    if (this.#provider && (this.services.providerRuntime !== this.#provider || this.#provider.binding?.configurationRevision !== this.#providerRevision))
      throw new Error("Protected provider instance or revision changed");
    if (this.#closed || !this.#valid || this.controller.signal.aborted || this.#expiresAt <= Date.now()) throw new Error("Protected worker is fenced");
    const source = this.#source; if (source) assertProtectedConnectionsCurrent(this.services, source, this.#connections);
  }
  #source: ReturnType<typeof parseWorkflowYAMLStrict> | undefined;
  async initialize(): Promise<void> {
    const initial = await this.repository.readAuthoritative(state => this.current(state));
    this.#source = parseWorkflowYAMLStrict(initial.run.workflowSnapshot!.yaml);
    const live = await discoverProtectedOperationConnections(this.services, this.#connections);
    const actor = await this.repository.effectiveUser(initial.run.startedBy.id); if (!actor) throw new Error("Protected actor unavailable");
    const gate = await validateWorkflow(this.services, "ProtectedOperationWorker", initial.run.workflowSnapshot!.yaml, actor,
      { workflowId: initial.run.workflowId, executionId: this.executionId, signal: this.controller.signal });
    this.assertDispatch();
    await this.repository.readAuthoritative(state => { const current = this.current(state); assertProtectedCapabilitiesDiscovered(current.plan, live);
      if (!gate.result.passed || !gate.token || !this.services.validator.verifyToken(gate.token) || gate.token.workflow_content_hash !== current.plan.sourceHash || gate.token.registry_hash !== current.run.workflowSnapshot!.registryHash)
        throw new Error("Protected worker verification failed"); });
    this.#token = gate.token!;
    this.#timer = setInterval(() => { void this.repository.mutateExecution(this.executionId, state => {
      this.assertDispatch(); const current = this.current(state); current.run.protectedJobSecret!.lease!.expiresAt = Date.now() + this.services.config.readWorkerLeaseMs;
    }).catch(() => { this.#valid = false; this.controller.abort(); }); }, Math.max(1000, Math.floor(this.services.config.readWorkerLeaseMs / 3)));
    this.#timer.unref();
  }
  async next(): Promise<ProtectedMachinePoint | undefined> {
    return this.repository.readAuthoritative(state => {
      if (state.executions[this.executionId]?.protectedJobSecret?.state === "FINISHED") return undefined;
      this.assertDispatch(); return this.current(state).machine.peek() ?? undefined;
    });
  }
  private advance(state: RepositoryState, result: ProtectedBoundaryResult, expected: ProtectedMachinePoint) {
    this.assertDispatch(); const saved = this.current(state), point = saved.machine.peek();
    if (!same(point, expected)) throw new Error("Protected invocation pointer changed before commit");
    const next = saved.ledger.advance(saved.machine, result), run = saved.run;
    run.protectedInvocationSecret = next.ledger; sealProtectedCursor(this.services, state, run, next.machine);
    (state.timelines[run.id] ??= []).push({ id: `protected-boundary-${expected.sequence}`, nodeId: expected.nodeId, invocationId: expected.invocationId,
      iterations: expected.iterations, kind: expected.kind, status: result.kind === "business-read-failure" ? "FAILED" : expected.kind === "skip" ? "SKIPPED" : "DONE",
      ...(expected.outcome ? { outcome: expected.outcome } : {}), completedAt: new Date().toISOString() });
    if (expected.kind === "action" && result.kind === "accept") (run.stepOutputs ??= {})[expected.invocationId] = result.output;
    if (expected.kind !== "action" && result.kind === "accept" && result.output !== undefined)
      (run.valueOutputs ??= {})[expected.invocationId] = structuredClone(result.output) as { value: unknown };
    appendExecutionEvent(state, run, "node.protected_boundary_confirmed", { invocationId: expected.invocationId, iterations: expected.iterations, kind: expected.kind,
      ...(expected.outcome ? { outcome: expected.outcome } : {}) }, expected.nodeId, expected.invocationId);
    const machineState = next.machine.snapshot();
    if (machineState.status !== "RUNNING") {
      run.protectedJobSecret!.state = machineState.status === "DONE" || machineState.status === "FAILED" ? "FINISHED" : "RECOVERY_REQUIRED";
      delete run.protectedJobSecret!.lease; run.status = machineState.status === "DONE" ? "DONE" : machineState.status === "FAILED" ? "FAILED" : "RECOVERY_REQUIRED";
      run.completedAt = new Date().toISOString(); run.durationMs = Date.now() - Date.parse(run.startedAt);
      if (machineState.result) run.finalOutput = machineState.result.value;
      run.agentSummary = run.status === "DONE" ? "The selected protected collection completed with confirmed per-invocation results." : "The protected collection stopped without replaying or inventing a result.";
      appendExecutionEvent(state, run, `run.${run.status.toLowerCase()}`, {});
    }
  }
  async advanceControl(expected: ProtectedMachinePoint): Promise<void> {
    if (expected.kind === "action") throw new Error("Action cannot use control acceptance");
    const typed = ["merge", "return", "collection-item"].includes(expected.kind) || expected.kind === "collection-complete" && expected.outcome !== "FAILED" ||
      expected.kind === "protected-complete" && ["SUCCEEDED", "HANDLED_ERROR"].includes(expected.outcome!);
    await this.repository.mutateExecution(this.executionId, state => this.advance(state, { kind: "accept", ...(typed ? { output: { value: expected.value } } : {}) }, expected));
  }
  /** Denial-only selected prerequisite view. Only currently visible, exactly
   * acknowledged lexical reads are included; failed/prior-item/handler locals
   * never acquire completion authority through their static node names. */
  prerequisiteYAML(state: Readonly<RepositoryState>, yaml: string, index: number, pin: ReadAdmissionPin | undefined, args: Record<string, unknown>): string {
    this.assertDispatch(); const saved = this.current(state), active = this.#read, point = saved.machine.peek();
    if (!active || saved.run.workflowSnapshot!.yaml !== yaml || active.index !== index || !same(point, active.point) || !same(pin, active.node.capability.admission) || !same(args, point?.arguments))
      throw new Error("Protected read does not own the exact selected invocation/arguments");
    const intent = saved.run.protectedInvocationSecret!.intents[active.key];
    if (!intent || !["PREPARING", "DISPATCH_INTENT"].includes(intent.state) || intent.epoch !== this.#owner.epoch) throw new Error("Protected read lacks its current prepared intent");
    const values = saved.machine.snapshot().values, receipts = Object.values(saved.run.protectedInvocationSecret!.receipts);
    const completed = new Set(receipts.filter(row => row.boundary.kind === "action" && row.result.kind === "accept" && Object.hasOwn(values, row.boundary.nodeId) &&
      same(values[row.boundary.nodeId], row.result.output) && row.boundary.iterations.every((frame, at) => at < point!.iterations.length && same(frame, point!.iterations[at]))).map(row => row.boundary.nodeId));
    const blueprint = parseWorkflowYAMLStrict(yaml), metadata = { ...blueprint.metadata }; delete metadata.controlFlow;
    return stringify({ ...blueprint, metadata, steps: blueprint.steps.filter(step => step.id === point!.nodeId || completed.has(step.id)) });
  }
  private async dispatchIntent(role: string): Promise<void> {
    await this.repository.mutateExecution(this.executionId, state => {
      this.assertDispatch(); const saved = this.current(state), active = this.#read;
      if (!active || role !== saved.run.protectedJobSecret!.admittedRole || !same(saved.machine.peek(), active.point)) throw new Error("Protected dispatch actor or invocation changed");
      saved.ledger.dispatchIntent(saved.machine, active.key, active.args, this.#owner.epoch);
      saved.run.protectedInvocationSecret = saved.ledger.snapshot(); sealProtectedCursor(this.services, state, saved.run, saved.machine);
      appendExecutionEvent(state, saved.run, "node.protected_dispatch_intent", { invocationId: active.point.invocationId }, active.point.nodeId, active.point.invocationId);
    });
  }
  /** Original compiled definition selects the driver, never caller flags. */
  async executeAction(): Promise<void> {
    if (this.#read || this.#analysis) throw new Error("Protected invocation is already active");
    const kind = await this.repository.readAuthoritative(state => {
      this.assertDispatch(); const saved = this.current(state), point = saved.machine.peek();
      return saved.plan.ir.root.nodes.find(node => node.id === point?.nodeId)?.kind;
    });
    if (kind === "analysis") await this.executeAnalysis(); else if (kind === "agent") await this.executeAgentBoundary(false); else await this.executeRead();
  }
  /** One genuine confirmed agent sub-call may be yielded/reopened. No supplied
   * turn, answer or serialized flag can invoke this owned driver. */
  async executeAgentBoundary(oneBoundary = true): Promise<void> {
    if (this.#read || this.#analysis || !this.#token || !this.#provider || !this.#providerRevision) throw new Error("Protected agent driver is unavailable or active");
    this.#analysis = true;
    try {
      await executeProtectedAgent(this.services, this.executionId, {
        mutate: fn => this.repository.mutateExecution(this.executionId, state => { this.assertDispatch(); return fn(this.current(state), state); }),
        seal: (saved, state) => { saved.run.protectedInvocationSecret = saved.ledger.snapshot(); sealProtectedCursor(this.services, state, saved.run, saved.machine); },
        advance: (saved, state, result, point) => {
          saved.run.protectedInvocationSecret = saved.ledger.snapshot(); sealProtectedCursor(this.services, state, saved.run, saved.machine); this.advance(state, result, point);
        },
        guard: () => this.assertDispatch(), provider: this.#provider, providerRevision: this.#providerRevision, epoch: this.#owner.epoch, signal: this.controller.signal,
        callRead: async (candidate, actorId, workflowId, signal) => {
          this.#agentRead = candidate;
          try {
            return await dispatchReadTool(this.services, actorId, candidate.capability.action, candidate.arguments, { workflowId, executionId: this.executionId,
              signal, protectedInvocation: { checkpoints: this }, dynamicPlan: { admissionPin: candidate.capability.admission,
                contractHash: candidate.capability.contractHash, toolId: candidate.capability.toolId }, assertDispatch: () => this.assertDispatch(),
              beforeDispatch: role => this.repository.mutateExecution(this.executionId, state => {
                this.agentReadPrerequisiteYAML(state, actorId, candidate.capability.action, candidate.arguments, candidate.capability);
                const saved = this.current(state);
                if (role !== saved.run.protectedJobSecret!.admittedRole) throw new Error("Owned agent read actor changed");
                saved.ledger.dispatchIntent(saved.machine, candidate.key, candidate.arguments, this.#owner.epoch);
                saved.run.protectedInvocationSecret = saved.ledger.snapshot(); sealProtectedCursor(this.services, state, saved.run, saved.machine);
                appendExecutionEvent(state, saved.run, "node.agent_tool_dispatch_intent", { invocationId: saved.machine.peek()!.invocationId,
                  component: candidate.component }, saved.machine.peek()!.nodeId, saved.machine.peek()!.invocationId);
              }) });
          } finally { this.#agentRead = undefined; }
        },
      }, oneBoundary);
    } finally { this.#analysis = false; }
  }
  /** Private active candidate plus authenticated dialogue/whole-source token.
   * This denial-only prefix does not turn a dynamic one-read gate into the
   * authority for an agent node, prior item, skipped branch or model output. */
  agentReadPrerequisiteYAML(state: Readonly<RepositoryState>, actorId: string, action: string, args: Record<string, unknown>, binding: { admissionPin?: ReadAdmissionPin; admission?: ReadAdmissionPin; toolId: string; contractHash: string }): string {
    this.assertDispatch(); const saved = this.current(state), active = this.#agentRead, point = saved.machine.peek();
    const node = saved.plan.ir.root.nodes.find(item => item.id === point?.nodeId), records = saved.run.protectedAgentSecret;
    const progress = point && records?.invocations[point.invocationId];
    if (!active || !point || node?.kind !== "agent" || !records || progress?.profile !== "protected-agent-invocation/v2" ||
        actorId !== saved.run.startedBy.id || action !== active.capability.action || !same(args, active.arguments) || binding.toolId !== active.capability.toolId ||
        binding.contractHash !== active.capability.contractHash || !same(binding.admissionPin ?? binding.admission, active.capability.admission) ||
        !this.#token || !this.services.validator.verifyToken(this.#token) || this.#token.workflow_content_hash !== saved.plan.sourceHash ||
        this.#token.registry_hash !== saved.run.workflowSnapshot!.registryHash) throw new Error("Owned agent read lacks its original private invocation binding");
    const ledger = saved.ledger.snapshot(), intent = ledger.intents[active.key];
    if (!intent || !["PREPARING", "DISPATCH_INTENT"].includes(intent.state) || intent.epoch !== this.#owner.epoch) throw new Error("Owned agent read has no exact current prepared intent");
    // Reconstruct the candidate as a DENIAL-ONLY view. The authentic entered
    // state remains unchanged and is never made replayable or re-persisted.
    intent.state = "PREPARING";
    const candidate = nextProtectedAgent({ node, point, model: progress.model, tools: progress.offers }, records, ledger, Date.now());
    if (candidate.kind !== "TOOL" || !same(candidate, active)) throw new Error("Owned agent read differs from its confirmed model dialogue");
    const values = saved.machine.snapshot().values;
    const completed = new Set(Object.values(ledger.receipts).filter(row => row.boundary.kind === "action" && row.result.kind === "accept" &&
      Object.hasOwn(values, row.boundary.nodeId) && same(values[row.boundary.nodeId], row.result.output) &&
      row.boundary.iterations.every((frame, at) => at < point.iterations.length && same(frame, point.iterations[at]))).map(row => row.boundary.nodeId));
    const blueprint = parseWorkflowYAMLStrict(saved.run.workflowSnapshot!.yaml), metadata = { ...blueprint.metadata }; delete metadata.controlFlow;
    const steps = blueprint.steps.filter(step => completed.has(step.id) && saved.plan.ir.root.nodes.some(item => item.id === step.id && item.kind === "action" && item.effectClass === "read"));
    const used = new Set(blueprint.steps.map(step => step.id));
    const id = (round: number, call: number) => { let result = `agentRead${round}_${call}`; while (used.has(result)) result += "x"; used.add(result); return result; };
    for (const row of Object.values(records.results).filter(row => row.invocationId === point.invocationId && row.result.kind === "OUTPUT").sort((a, b) => a.round - b.round || a.callIndex - b.callIndex)) {
      const turn = Object.values(records.turns).find(turn => turn.invocationId === point.invocationId && turn.round === row.round)!, call = turn.turn.toolCalls[row.callIndex]!;
      const capability = node.allowedCapabilities.find(item => item.remoteName === call.name)!;
      steps.push({ id: id(row.round, row.callIndex), action: capability.action, parameters: call.arguments });
    }
    steps.push({ id: id(active.component.round, active.component.callIndex), action, parameters: args });
    return stringify({ ...blueprint, metadata, steps });
  }
  /** Only a captured genuine provider response can acknowledge analysis. A
   * public error/result, model tool request or malformed output is never an ERP
   * business fault and cannot select a handler. No model fallback/replay. */
  private async executeAnalysis(): Promise<void> {
    if (this.#read || this.#analysis || !this.#token || !this.#provider || !this.#providerRevision) throw new Error("Protected analysis driver is unavailable or active");
    this.#analysis = true;
    try {
      const prepared = await this.repository.mutateExecution(this.executionId, state => {
        this.assertDispatch(); const saved = this.current(state), point = saved.machine.peek();
        const node = saved.plan.ir.root.nodes.find(value => value.id === point?.nodeId);
        if (!point?.valid || point.kind !== "action" || node?.kind !== "analysis") throw new Error("Protected analysis has no exact original invocation");
        const input = point.arguments, json = JSON.stringify(input);
        if (modelInputItemCount(node.input, input) > node.maxInputItems || [...json].length > node.maxInputChars) throw new Error("Protected analysis input exceeds its reviewed bounds");
        const configuration = this.#provider!.configuration!;
        assertRuntimeAnalysisEgress(configuration.egressPolicy!, configuration.baseURL, node.dataClass);
        const model = node.model || configuration.model;
        if (!this.#provider!.catalog().models.includes(model)) throw new Error("Protected analysis model is not configured");
        const old = Object.values(saved.ledger.snapshot().intents).find(item => item.sequence === point.sequence);
        if (old && (old.state !== "PREPARING" || old.purpose !== "analysis" || old.epoch !== this.#owner.epoch)) throw new Error("Protected analysis cannot replay an entered invocation");
        const key = old?.key ?? saved.ledger.prepare(saved.machine, "analysis", { kind: "node" }, input, this.#owner.epoch);
        saved.run.protectedInvocationSecret = saved.ledger.snapshot(); sealProtectedCursor(this.services, state, saved.run, saved.machine);
        appendExecutionEvent(state, saved.run, "node.analysis_preparing", { invocationId: point.invocationId, model, dataClass: node.dataClass }, point.nodeId, point.invocationId);
        return { point, node, input, key, model, configuration, actorId: saved.run.startedBy.id, role: saved.run.protectedJobSecret!.admittedRole, workflowId: saved.run.workflowId };
      });
      const send = this.#provider.fetchImplementation ?? fetch;
      const guarded = new ProviderRuntime(this.repository, this.services.executor, (url, init) => {
        // Synchronous final boundary after all provenance/policy awaits.
        this.assertDispatch(); return send(url, init);
      }).restoreCaptured(prepared.configuration, this.#providerRevision).snapshot(prepared.model);
      await this.repository.mutateExecution(this.executionId, state => {
        this.assertDispatch(); const saved = this.current(state);
        if (!same(saved.machine.peek(), prepared.point)) throw new Error("Protected analysis pointer or arguments changed");
        saved.ledger.dispatchIntent(saved.machine, prepared.key, prepared.input, this.#owner.epoch);
        saved.run.protectedInvocationSecret = saved.ledger.snapshot(); sealProtectedCursor(this.services, state, saved.run, saved.machine);
        appendExecutionEvent(state, saved.run, "node.analysis_dispatch_intent", { invocationId: prepared.point.invocationId, model: prepared.model }, prepared.point.nodeId, prepared.point.invocationId);
      });
      this.assertDispatch();
      const response = await guarded.generate(promptData({ INSTRUCTION: prepared.node.instruction, OUTPUT_SCHEMA: prepared.node.outputSchema, INPUT: prepared.input }),
        ANALYSIS_PROMPT_VERSION, this.controller.signal, prepared.model, { workflowId: prepared.workflowId, executionId: this.executionId,
          actor: { id: prepared.actorId, role: prepared.role }, maxOutputTokens: prepared.node.maxOutputTokens, egress: { purpose: "runtime_analysis", dataClass: prepared.node.dataClass } });
      const decoded: unknown = JSON.parse(response.text), safe = withoutSecretFields(decoded);
      if (!safe || typeof safe !== "object" || Array.isArray(safe) || canonicalJSONBytes(safe).length > 1_000_000 || validateValue(prepared.node.outputSchema, safe).length)
        throw new Error("Protected analysis output violates its immutable schema");
      const output = { structuredContent: safe };
      await this.repository.mutateExecution(this.executionId, state => {
        this.assertDispatch(); const saved = this.current(state);
        const inputTokens = response.measured ? response.inputTokens : 0, outputTokens = response.measured ? response.outputTokens : 0;
        const nextInput = saved.run.tokens.input + inputTokens, nextOutput = saved.run.tokens.output + outputTokens;
        if (![inputTokens, outputTokens, nextInput, nextOutput, nextInput + nextOutput].every(value => Number.isSafeInteger(value) && value >= 0) ||
            response.measured && outputTokens > prepared.node.maxOutputTokens) throw new Error("Protected analysis usage is unsafe or exceeds its output token budget");
        saved.ledger.acknowledgeOutput(saved.machine, prepared.key, output, this.#owner.epoch);
        saved.run.protectedInvocationSecret = saved.ledger.snapshot(); sealProtectedCursor(this.services, state, saved.run, saved.machine);
        saved.run.tokens.input = nextInput; saved.run.tokens.output = nextOutput;
        saved.run.tokens.total = saved.run.tokens.input + saved.run.tokens.output;
        appendExecutionEvent(state, saved.run, "node.analysis_completed", { invocationId: prepared.point.invocationId, model: prepared.model, outcome: "ANALYSIS_STRUCTURED_OUTPUT",
          measured: response.measured, ...(response.measured ? { inputTokens, outputTokens } : {}) }, prepared.point.nodeId, prepared.point.invocationId);
        this.advance(state, { kind: "accept", output }, prepared.point);
      });
    } finally { this.#analysis = false; }
  }
  /** Read completion requires a real governed broker return or its
   * privately minted acknowledged business-error evidence, never caller data. */
  async executeRead(): Promise<void> {
    if (this.#read || this.#analysis || !this.#token) throw new Error("Protected read is already active or worker is unverified");
    const prepared = await this.repository.mutateExecution(this.executionId, state => {
      this.assertDispatch(); const saved = this.current(state), point = saved.machine.peek();
      if (!point?.valid || point.kind !== "action") throw new Error("Protected read has no exact action");
      const index = saved.plan.ir.root.nodes.findIndex(node => node.id === point.nodeId), node = saved.plan.ir.root.nodes[index];
      if (node?.kind !== "action" || node.effectClass !== "read" || !node.capability.admission || saved.plan.ir.contracts[node.capability.toolId]?.reportCoverageContract)
        throw new Error("Protected invocation requires a separately qualified driver");
      const args = point.arguments as Record<string, unknown>, old = Object.values(saved.ledger.snapshot().intents).find(item => item.sequence === point.sequence);
      const key = old?.state === "PREPARING" ? old.key : saved.ledger.prepare(saved.machine, "read", { kind: "node" }, args, this.#owner.epoch);
      if (old && (old.state !== "PREPARING" || old.epoch !== this.#owner.epoch)) throw new Error("Protected call cannot replay an entered intent");
      saved.run.protectedInvocationSecret = saved.ledger.snapshot(); sealProtectedCursor(this.services, state, saved.run, saved.machine);
      appendExecutionEvent(state, saved.run, "node.protected_preparing", { invocationId: point.invocationId }, point.nodeId, point.invocationId);
      return { point, node, index, key, args, outputSchema: saved.plan.ir.contracts[node.capability.toolId]!.outputSchema!, yaml: saved.run.workflowSnapshot!.yaml, actorId: saved.run.startedBy.id, workflowId: saved.run.workflowId };
    });
    this.#read = prepared;
    try {
      const output = await dispatchReadTool(this.services, prepared.actorId, prepared.node.capability.action, prepared.args, {
        executionId: this.executionId, workflowId: prepared.workflowId, signal: this.controller.signal, assertDispatch: () => this.assertDispatch(),
        beforeDispatch: role => this.dispatchIntent(role), protectedInvocation: { checkpoints: this },
        plan: { yaml: prepared.yaml, stepIndex: prepared.index, token: this.#token, admissionPin: prepared.node.capability.admission!, toolId: prepared.node.capability.toolId, contractHash: prepared.node.capability.contractHash } });
      if (validateToolInput(prepared.outputSchema, output.structuredContent).length) throw new Error("Protected read output violates its exact contract");
      const safe = withoutSecretFields(output);
      await this.repository.mutateExecution(this.executionId, state => {
        this.assertDispatch(); const saved = this.current(state);
        saved.ledger.acknowledgeOutput(saved.machine, prepared.key, safe, this.#owner.epoch);
        // ACK evidence, next cursor, scoped values and answer share ONE commit.
        saved.run.protectedInvocationSecret = saved.ledger.snapshot(); sealProtectedCursor(this.services, state, saved.run, saved.machine);
        this.advance(state, { kind: "accept", output: safe }, prepared.point);
      });
    } catch (error) {
      const failure = acknowledgedReadToolFailure(error), business = failure?.businessFailure;
      if (!business || this.controller.signal.aborted || !same(business.admissionPin, prepared.node.capability.admission) || business.toolId !== prepared.node.capability.toolId || business.contractHash !== prepared.node.capability.contractHash)
        throw error;
      await this.repository.mutateExecution(this.executionId, state => {
        this.assertDispatch(); const saved = this.current(state), fault = { code: business.code, failedNodeId: prepared.point.nodeId, failedInvocationId: prepared.point.invocationId };
        saved.ledger.acknowledgeReadError(saved.machine, prepared.key, fault, business, this.#owner.epoch);
        saved.run.protectedInvocationSecret = saved.ledger.snapshot(); sealProtectedCursor(this.services, state, saved.run, saved.machine);
        this.advance(state, { kind: "business-read-failure", fault, intentKey: prepared.key, businessFailureHash: hash(business) }, prepared.point);
      });
    } finally { this.#read = undefined; }
  }
  /** Stop without actor/dispatch permission, but only under this exact saved
   * worker claim. Unknown entered calls are never catchable or replayed. */
  async stop(): Promise<void> {
    await this.repository.mutateExecution(this.executionId, state => {
      const saved = restoreProtectedJob(state, this.services, this.executionId), { run, ledger, machine } = saved, job = run.protectedJobSecret!;
      if (job.state !== "CLAIMED" || job.lease?.id !== this.#owner.leaseId || job.lease.workerId !== this.#owner.workerId || run.readProgress!.epoch !== this.#owner.epoch) return;
      const pending = Object.values(ledger.snapshot().intents).filter(item => item.sequence === machine.snapshot().sequence), entered = pending.some(item => item.state === "DISPATCH_INTENT" || item.state === "UNKNOWN");
      for (const item of pending) if (item.state === "DISPATCH_INTENT") ledger.unknown(machine, item.key, item.epoch);
      run.protectedInvocationSecret = ledger.snapshot(); job.state = entered ? "RECOVERY_REQUIRED" : "FINISHED"; delete job.lease;
      run.status = entered ? "RECOVERY_REQUIRED" : run.readProgress!.cancellation ? "CANCELLED" : "FAILED"; run.completedAt = new Date().toISOString();
      run.agentSummary = entered ? "The current invocation has no confirmed outcome. No handler, next item or replay was started." : "The protected worker stopped before further SDK entry. Confirmed earlier answers remain available.";
      sealProtectedCursor(this.services, state, run, machine); appendExecutionEvent(state, run, `run.${run.status.toLowerCase()}`, { reason: "PROTECTED_WORKER_STOPPED" });
    });
  }
  /** Explicit clean yield ONLY between confirmed boundaries, never in flight. */
  async yield(): Promise<void> {
    await this.repository.mutateExecution(this.executionId, state => {
      this.assertDispatch(); const saved = this.current(state);
      const pending = Object.values(saved.ledger.snapshot().intents).filter(item => item.sequence === saved.machine.snapshot().sequence);
      if (this.#read || this.#analysis || pending.some(item => item.state !== "ACKNOWLEDGED")) throw new Error("Protected worker cannot yield with a pending call");
      if (pending.length) {
        const point = saved.machine.peek()!, node = saved.plan.ir.root.nodes.find(item => item.id === point.nodeId), records = saved.run.protectedAgentSecret,
          progress = records?.invocations[point.invocationId];
        if (node?.kind !== "agent" || !records || progress?.profile !== "protected-agent-invocation/v2") throw new Error("Protected yield lacks complete agent dialogue");
        const next = nextProtectedAgent({ node, point, model: progress.model, tools: progress.offers }, records, saved.ledger.snapshot(), Date.now());
        if (!["MODEL", "TOOL"].includes(next.kind)) throw new Error("Protected agent must confirm its terminal boundary before yield");
      }
      saved.run.status = "PENDING"; saved.run.protectedJobSecret!.state = "QUEUED"; delete saved.run.protectedJobSecret!.lease;
      appendExecutionEvent(state, saved.run, "run.checkpoint_yielded", {});
    });
    this.close();
  }
  close(): void { if (this.#closed) return; this.#closed = true; if (this.#timer) clearInterval(this.#timer); this.#unsubscribe(); this.#unsubscribeProvider?.(); this.controller.abort(); }
}

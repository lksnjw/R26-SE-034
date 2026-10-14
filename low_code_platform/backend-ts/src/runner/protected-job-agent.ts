import type { RepositoryState } from "../repository/store.js";
import type { HandlerServices } from "../http/handlers/common.js";
import type { ProtectedBoundaryResult } from "../repository/protected-invocation-records.js";
import { emptyProtectedAgentRecords } from "../repository/protected-agent-records.js";
import type { ProtectedMachinePoint } from "../workflows/protected-machine-state.js";
import { protectedAgentProgress, nextProtectedAgent, protectedAgentTurnOutput } from "./protected-agent-protocol.js";
import { ProviderRuntime } from "../providers/runtime.js";
import { assertRuntimeAgentEgress } from "../providers/egress-policy.js";
import { appendExecutionEvent } from "./read-checkpoints.js";
import { protectedHash as hash, type restoreProtectedJob } from "./protected-job-state.js";
import { acknowledgedReadToolFailure } from "../tools/read-tool-broker.js";
import { withoutSecretFields } from "../redact/secrets.js";

type Saved = ReturnType<typeof restoreProtectedJob>;
export type ProtectedAgentCandidate = Extract<ReturnType<typeof nextProtectedAgent>, { kind: "TOOL" }>;
type Hooks = {
  mutate<T>(fn: (saved: Saved, state: RepositoryState) => T): Promise<T>;
  seal(saved: Saved, state: RepositoryState): void;
  advance(saved: Saved, state: RepositoryState, result: ProtectedBoundaryResult, point: ProtectedMachinePoint): void;
  guard(): void;
  callRead(candidate: ProtectedAgentCandidate, actorId: string, workflowId: string, signal: AbortSignal): Promise<Record<string, unknown>>;
  provider: ProviderRuntime;
  providerRevision: string;
  epoch: number;
  signal: AbortSignal;
};

/** Invoked only by the owned controller, whose closures retain final-use
 * authority and private broker context. This module cannot mint that context.
 * Each genuine sub-call ACK and complete saved artifact share one checkpoint. */
export async function executeProtectedAgent(services: HandlerServices, executionId: string, hooks: Hooks, oneBoundary: boolean): Promise<void> {
  const initialized = await hooks.mutate((saved, state) => {
    const point = saved.machine.peek(), node = saved.plan.ir.root.nodes.find(item => item.id === point?.nodeId);
    if (!point?.valid || point.kind !== "action" || node?.kind !== "agent") throw new Error("Owned agent has no exact authored boundary");
    const configuration = hooks.provider.configuration!;
    assertRuntimeAgentEgress(configuration.egressPolicy!, configuration.baseURL, node.dataClass);
    const model = node.model || configuration.model;
    if (!hooks.provider.catalog().models.includes(model)) throw new Error("Owned agent model is not configured");
    const records = saved.run.protectedAgentSecret ??= emptyProtectedAgentRecords();
    if (records.profile !== "protected-agent-records/v2") throw new Error("Owned agent cannot reinterpret historical v1 dialogue");
    if (!records.invocations[point.invocationId]) {
      records.invocations[point.invocationId] = protectedAgentProgress({ node, point, model, tools: services.registries.snapshot().tools }, Date.now());
      appendExecutionEvent(state, saved.run, "node.agent_started", { invocationId: point.invocationId, model, dataClass: node.dataClass }, point.nodeId, point.invocationId);
    }
    hooks.seal(saved, state);
    return { point, node, model, configuration, actorId: saved.run.startedBy.id, role: saved.run.protectedJobSecret!.admittedRole, workflowId: saved.run.workflowId,
      deadline: records.invocations[point.invocationId]!.deadline };
  });
  const remaining = initialized.deadline - Date.now();
  const signal = AbortSignal.any([hooks.signal, remaining > 0 ? AbortSignal.timeout(remaining) : AbortSignal.abort(new Error("Owned agent original deadline expired"))]);
  const send = hooks.provider.fetchImplementation ?? fetch;
  const runtime = new ProviderRuntime(services.repository, services.executor, (url, init) => {
    hooks.guard(); if (signal.aborted || Date.now() >= initialized.deadline) throw new Error("Owned agent original deadline expired"); return send(url, init);
  }).restoreCaptured(initialized.configuration, hooks.providerRevision).snapshot(initialized.model);
  const next = (saved: Saved) => {
    const progress = saved.run.protectedAgentSecret!.invocations[initialized.point.invocationId]!;
    if (progress.profile !== "protected-agent-invocation/v2") throw new Error("Owned agent offers are missing");
    return nextProtectedAgent({ node: initialized.node, point: initialized.point, model: initialized.model, tools: progress.offers },
      saved.run.protectedAgentSecret!, saved.ledger.snapshot(), Date.now());
  };
  for (;;) {
    const prepared = await hooks.mutate((saved, state) => {
      const step = next(saved);
      if (step.kind === "RECOVERY_REQUIRED") throw new Error("Owned agent call is entered/unconfirmed and cannot be replayed");
      if (step.kind === "READ_ERROR") {
        const result = saved.ledger.snapshot().intents[step.key]!.result!;
        if (result.kind !== "READ_ERROR") throw new Error("Owned agent saved read error is missing");
        hooks.advance(saved, state, { kind: "business-read-failure", fault: step.fault, intentKey: step.key, businessFailureHash: result.businessFailureHash }, initialized.point);
        return { done: true as const };
      }
      if (step.kind === "COMPLETE") {
        hooks.advance(saved, state, { kind: "accept", output: step.output }, initialized.point); return { done: true as const };
      }
      const intent = saved.ledger.snapshot().intents[step.key];
      if (!intent) saved.ledger.prepare(saved.machine, step.kind === "MODEL" ? "agent-model" : "agent-tool", step.component, step.arguments, hooks.epoch);
      else if (intent.state !== "PREPARING" || intent.epoch !== hooks.epoch) throw new Error("Owned agent preparation cannot replay a call");
      hooks.seal(saved, state);
      appendExecutionEvent(state, saved.run, step.kind === "MODEL" ? "node.agent_model_preparing" : "node.agent_tool_preparing",
        { invocationId: initialized.point.invocationId, component: step.component }, initialized.point.nodeId, initialized.point.invocationId);
      return { done: false as const, step };
    });
    if (prepared.done) return;
    const { step } = prepared;
    if (step.kind === "MODEL") {
      await hooks.mutate((saved, state) => {
        const current = next(saved); if (current.kind !== "MODEL" || hash(current) !== hash(step)) throw new Error("Owned agent model dialogue changed");
        saved.ledger.dispatchIntent(saved.machine, step.key, step.arguments, hooks.epoch); hooks.seal(saved, state);
        appendExecutionEvent(state, saved.run, "node.agent_model_dispatch_intent", { invocationId: initialized.point.invocationId, component: step.component }, initialized.point.nodeId, initialized.point.invocationId);
      });
      hooks.guard();
      const turn = await runtime.queryWithTools(step.arguments.messages, step.arguments.definitions, { model: initialized.model,
        maxOutputTokens: step.arguments.maxOutputTokens, promptTemplateVersion: step.arguments.promptTemplateVersion, signal,
        context: { workflowId: initialized.workflowId, executionId, actor: { id: initialized.actorId, role: initialized.role }, egress: { purpose: "runtime_agent", dataClass: initialized.node.dataClass } } });
      const output = protectedAgentTurnOutput(initialized.node, initialized.model, turn, step.inputTokens + step.outputTokens);
      await hooks.mutate((saved, state) => {
        if (Date.now() >= initialized.deadline) throw new Error("Owned agent response arrived after its original deadline");
        const inputTokens = saved.run.tokens.input + turn.inputTokens, outputTokens = saved.run.tokens.output + turn.outputTokens;
        if (![inputTokens, outputTokens, inputTokens + outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error("Owned agent cumulative run usage is unsafe");
        saved.ledger.acknowledgeOutput(saved.machine, step.key, output, hooks.epoch);
        const records = saved.run.protectedAgentSecret!;
        records.turns[step.key] = { profile: "protected-agent-turn/v1", invocationId: initialized.point.invocationId, round: step.component.round, turn: { ...turn, measured: true } };
        records.invocations[initialized.point.invocationId]!.turnCount++;
        saved.run.tokens = { input: inputTokens, output: outputTokens, total: inputTokens + outputTokens };
        next(saved); // Validate complete proposed batch before committing ACK.
        hooks.seal(saved, state);
        appendExecutionEvent(state, saved.run, "node.agent_model_completed", { invocationId: initialized.point.invocationId, component: step.component, model: initialized.model,
          measured: true, inputTokens: turn.inputTokens, outputTokens: turn.outputTokens }, initialized.point.nodeId, initialized.point.invocationId);
        // A terminal model ACK, complete turn, public answer and node boundary
        // share one commit; intermediate turns leave the same node pending.
        if (!turn.toolCalls.length) hooks.advance(saved, state, { kind: "accept", output }, initialized.point);
      });
      if (!turn.toolCalls.length) return;
    } else {
      try {
        const output = withoutSecretFields(await hooks.callRead(step, initialized.actorId, initialized.workflowId, signal)) as Record<string, unknown>;
        await hooks.mutate((saved, state) => {
          if (Date.now() >= initialized.deadline) throw new Error("Owned agent tool answer arrived after its original deadline");
          saved.ledger.acknowledgeOutput(saved.machine, step.key, output, hooks.epoch);
          const records = saved.run.protectedAgentSecret!;
          records.results[step.key] = { profile: "protected-agent-result/v1", invocationId: initialized.point.invocationId, round: step.component.round,
            callIndex: step.component.callIndex, result: { kind: "OUTPUT", output } };
          records.invocations[initialized.point.invocationId]!.resultCount++; next(saved); hooks.seal(saved, state);
          appendExecutionEvent(state, saved.run, "node.agent_tool_completed", { invocationId: initialized.point.invocationId, component: step.component,
            action: step.capability.action }, initialized.point.nodeId, initialized.point.invocationId);
        });
      } catch (error) {
        const business = acknowledgedReadToolFailure(error)?.businessFailure;
        if (!business || signal.aborted || Date.now() >= initialized.deadline || hash(business.admissionPin) !== hash(step.capability.admission) || business.toolId !== step.capability.toolId || business.contractHash !== step.capability.contractHash) throw error;
        await hooks.mutate((saved, state) => {
          if (signal.aborted || Date.now() >= initialized.deadline) throw new Error("Owned agent business answer arrived after its original deadline");
          const fault = { code: business.code, failedNodeId: initialized.point.nodeId, failedInvocationId: initialized.point.invocationId };
          saved.ledger.acknowledgeReadError(saved.machine, step.key, fault, business, hooks.epoch);
          const records = saved.run.protectedAgentSecret!;
          records.results[step.key] = { profile: "protected-agent-result/v1", invocationId: initialized.point.invocationId, round: step.component.round,
            callIndex: step.component.callIndex, result: { kind: "READ_ERROR", fault } };
          records.invocations[initialized.point.invocationId]!.resultCount++; hooks.seal(saved, state);
          hooks.advance(saved, state, { kind: "business-read-failure", fault, intentKey: step.key, businessFailureHash: hash(business) }, initialized.point);
        });
        return;
      }
    }
    if (oneBoundary) return;
  }
}

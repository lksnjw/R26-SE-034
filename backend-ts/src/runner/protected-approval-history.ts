import type { Execution } from "../repository/store.js";
import type { CompiledProtectedOperationPlan } from "../workflows/protected-operation-compiler.js";
import { ProtectedMachine } from "../workflows/protected-machine.js";
import { protectedJournalHash as hash } from "../repository/protected-invocation-records.js";
import { assertProtectedApprovalRecords } from "../repository/protected-approval-records.js";

/** Original semantic replay, separate from current approver/dispatch authority.
 * Called only after the full private continuation binding is authenticated.
 * This optional DATA foundation does not enable an effect/approval driver. */
export function assertProtectedApprovalHistory(plan: CompiledProtectedOperationPlan, run: Execution): void {
  const records = run.protectedApprovalSecret; if (!records) return;
  const ledger = run.protectedInvocationSecret!; assertProtectedApprovalRecords(records, ledger);
  const bySequence = new Map(Object.values(records.records).map(record => [record.binding.sequence, record]));
  const replay = new ProtectedMachine(plan.machine, run.workflowSnapshot!.input); replay.peek();
  for (let at = 0; at <= ledger.nextSequence; at++) {
    const record = bySequence.get(at), point = replay.peek();
    if (record) {
      const b = record.binding, node = plan.ir.root.nodes.find(item => item.id === b.nodeId);
      if (!point?.valid || point.kind !== "action" || node?.kind !== "action" || node.effectClass === "read" ||
          b.pointHash !== hash(point) || b.nodeHash !== hash(node) || b.argumentHash !== hash(point.arguments) ||
          hash(b.admission) !== hash(node.capability.admission)) throw new Error("Protected approval does not reproduce its original exact item and compiled effect");
    }
    if (at < ledger.nextSequence) {
      const result = ledger.receipts[String(at)]!.result;
      if (result.kind === "accept") replay.accept(result.output); else replay.fail(result.fault);
      replay.peek();
    }
  }
}

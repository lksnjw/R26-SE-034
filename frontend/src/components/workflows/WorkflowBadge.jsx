import { STATUS_META } from "../../constants/workflowStatus";

function WorkflowBadge({ status }) {
  const meta = STATUS_META[status] ?? STATUS_META.PENDING;

  return <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${meta.color}`}>{meta.label}</span>;
}

export default WorkflowBadge;

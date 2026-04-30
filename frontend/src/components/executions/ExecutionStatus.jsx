import { Icon } from "@iconify/react";
import { STATUS_META } from "../../constants/workflowStatus";

const icons = {
  RUNNING: "mdi:play-circle-outline",
  DONE: "mdi:check-circle-outline",
  FAILED: "mdi:alert-circle-outline",
  HEALING: "mdi:shield-refresh-outline",
  PENDING: "mdi:clock-outline",
};

function ExecutionStatus({ status }) {
  const meta = STATUS_META[status] ?? STATUS_META.PENDING;

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold ${meta.color}`}>
      <Icon icon={icons[status] ?? icons.PENDING} className="h-4 w-4" />
      {meta.label}
    </span>
  );
}

export default ExecutionStatus;

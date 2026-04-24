import { Icon } from "@iconify/react";
import { workflowNodes } from "../../constants/mockData";
import { STATUS_META } from "../../constants/workflowStatus";

const connectors = [
  ["trigger", "classify"],
  ["classify", "policy"],
  ["policy", "notify"],
  ["policy", "repair"],
];

function FlowCanvas() {
  return (
    <div className="workflow-canvas-grid relative h-[560px] overflow-hidden rounded-2xl border border-gray-200 dark:border-gray-800">
      <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
        {connectors.map(([from, to]) => {
          const source = workflowNodes.find((node) => node.id === from);
          const target = workflowNodes.find((node) => node.id === to);
          if (!source || !target) return null;
          const x1 = source.x + 168;
          const y1 = source.y + 42;
          const x2 = target.x;
          const y2 = target.y + 42;
          return (
            <path
              key={`${from}-${to}`}
              d={`M ${x1} ${y1} C ${x1 + 55} ${y1}, ${x2 - 55} ${y2}, ${x2} ${y2}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-primary/40"
            />
          );
        })}
      </svg>

      {workflowNodes.map((node) => {
        const meta = STATUS_META[node.status] ?? STATUS_META.PENDING;
        return (
          <div
            key={node.id}
            className="workflow-node absolute p-4"
            style={{ left: node.x, top: node.y }}
          >
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Icon icon={node.icon} className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-bold text-gray-950 dark:text-white">{node.label}</p>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{node.type}</p>
              </div>
            </div>
            <span className={`mt-4 inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${meta.color}`}>
              {meta.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default FlowCanvas;

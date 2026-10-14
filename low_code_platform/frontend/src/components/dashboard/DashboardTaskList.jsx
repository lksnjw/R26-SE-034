import { ArrowUpRight, CircleAlert, Clock3 } from "lucide-react";
import { Link } from "react-router-dom";
import { statusMetaFor } from "../../constants/workflowStatus";

function taskStatus(task, generatedAt) {
  if (task.kind === "schedule") return task.status === "ACTIVE" ? Date.parse(task.at) < Date.parse(generatedAt) ? "Overdue · not started" : "Scheduled · not started" : "Schedule blocked";
  if (task.kind === "occurrence") return { ADMITTING: "Starting", ADMITTED: "Run admitted", SKIPPED: "Skipped", BLOCKED: "Occurrence blocked" }[task.status] ?? "Status not reported";
  return statusMetaFor(task.status).label;
}
export default function DashboardTaskList({ tasks, timezone, generatedAt, empty }) {
  if (!tasks.length) return <div className="py-16 text-center text-sm text-gray-500 dark:text-gray-400"><Clock3 className="mx-auto mb-3 opacity-50" size={24} /><p>{empty}</p></div>;
  return <ul className="divide-y divide-gray-100 dark:divide-gray-800">
    {tasks.map(task => {
      const to = task.executionId ? `/executions/${encodeURIComponent(task.executionId)}` : task.workflowId ? `/workflows/${encodeURIComponent(task.workflowId)}` : null;
      return <li key={task.id} className="flex items-start gap-3 py-5">
        <span className={`mt-1 rounded-full p-2 ${task.important ? "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-200" : "bg-gray-100 text-gray-500 dark:bg-gray-800"}`}>{task.important ? <CircleAlert size={16} aria-label="Important" /> : <Clock3 size={16} />}</span>
        <div className="min-w-0 flex-1">
          {to ? <Link className="group flex items-start gap-2 text-sm font-semibold hover:text-primary" to={to}><span className="break-words">{task.name}</span><ArrowUpRight size={15} className="mt-0.5 shrink-0 transition-transform group-hover:-translate-y-0.5 motion-reduce:transform-none" /></Link> : <p className="break-words text-sm font-semibold">{task.name}</p>}
          <p className={`mt-1 text-xs ${task.important ? "text-amber-700 dark:text-amber-200" : "text-gray-500 dark:text-gray-400"}`}>{taskStatus(task, generatedAt)}</p>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{task.at ? new Intl.DateTimeFormat(undefined, { timeZone: timezone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(task.at)) : "No next run confirmed"}
            {task.cadence ? ` · ${task.cadence[0].toUpperCase()}${task.cadence.slice(1)} · ${task.scheduleTimezone}` : task.kind === "run" ? " · Saved run" : " · Recorded occurrence"}</p>
        </div>
      </li>;
    })}
  </ul>;
}

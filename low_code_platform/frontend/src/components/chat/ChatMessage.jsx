import { Icon } from "@iconify/react";
import MessageMarkdown from "./MessageMarkdown";

const NEXT_ACTION_LABELS = {
  capability_request_or_schema_generation: { icon: "mdi:tools", label: "Capability Request Needed", color: "text-amber-500" },
  escalate: { icon: "mdi:account-alert-outline", label: "Escalation Needed", color: "text-red-500" },
  execute: { icon: "mdi:check-circle", label: "Ready to Execute", color: "text-emerald-500" },
};

function ChatMessage({ message }) {
  const isUser = message.role === "user";
  const artifacts = message.artifacts;

  const blockingErrors = artifacts?.blocking_errors ?? [];
  const canExecute = artifacts?.can_execute;
  const nextAction = artifacts?.next_action;
  const hasArtifacts = artifacts && (blockingErrors.length > 0 || nextAction);

  const nextMeta = NEXT_ACTION_LABELS[nextAction];

  return (
    <div className={`flex flex-col ${isUser ? "items-end" : "items-start"} gap-1`}>
      {/* ── Main bubble ── */}
      <div
        className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-6 ${
          isUser
            ? "bg-primary text-white"
            : "bg-backgroundLight text-gray-800 dark:bg-darkBackgroundVery dark:text-gray-100"
        }`}
      >
        <MessageMarkdown text={message.text} />
      </div>

      {/* ── Artifact inline summary (assistant only) ── */}
      {!isUser && hasArtifacts && (
        <div className="ml-1 max-w-[88%] space-y-1.5">
          {/* Blocking errors – collapsed list */}
          {blockingErrors.length > 0 && (
            <div className="rounded-xl border border-red-100 bg-red-50 px-3 py-2 dark:border-red-900/40 dark:bg-red-900/10">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-red-700 dark:text-red-400">
                <Icon icon="mdi:alert-circle" className="h-3.5 w-3.5" />
                {blockingErrors.length} blocking {blockingErrors.length === 1 ? "error" : "errors"}
              </div>
              <ul className="mt-1 space-y-0.5 text-[11px] text-red-600 dark:text-red-400">
                {blockingErrors.slice(0, 2).map((e, i) => (
                  <li key={i} className="line-clamp-1">• {e}</li>
                ))}
                {blockingErrors.length > 2 && (
                  <li className="text-red-400">+{blockingErrors.length - 2} more — see Artifact Panel</li>
                )}
              </ul>
            </div>
          )}

          {/* Next action + can_execute badge */}
          {(nextMeta || canExecute != null) && (
            <div className="flex items-center gap-2">
              {nextMeta && (
                <div className={`flex items-center gap-1 text-[11px] font-semibold ${nextMeta.color}`}>
                  <Icon icon={nextMeta.icon} className="h-3.5 w-3.5" />
                  {nextMeta.label}
                </div>
              )}
              {canExecute != null && (
                <div className={`ml-auto flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                  canExecute
                    ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                    : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
                }`}>
                  <Icon icon={canExecute ? "mdi:check" : "mdi:close"} className="h-3 w-3" />
                  {canExecute ? "Executable" : "Blocked"}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Timestamp ── */}
      {message.createdAt && (
        <span className="px-1 text-[10px] text-gray-400">
          {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      )}
    </div>
  );
}

export default ChatMessage;

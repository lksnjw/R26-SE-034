import { Icon } from "@iconify/react";

// ── Next-action banner ──────────────────────────────────────────────────────
const NEXT_ACTION_META = {
  capability_request_or_schema_generation: {
    icon: "mdi:tools",
    color: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300",
    label: "Capability Request Required",
    desc: "These tools need an MCP schema before they can execute. Submit a capability request or generate the ERPBridge schema.",
  },
  escalate: {
    icon: "mdi:account-alert-outline",
    color: "border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300",
    label: "Escalation Required",
    desc: "A required governance rule is missing. Escalate to the governance owner.",
  },
  execute: {
    icon: "mdi:check-circle-outline",
    color: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-900/20 dark:text-emerald-300",
    label: "Candidate Validated",
    desc: "The draft passed candidate validation. Publication, current readiness and any required approval are checked separately before execution.",
  },
};

/*******************************************************************************
 * Function: NextActionBanner
 *
 * Performs the Next Action Banner operation on action banner for the ChatArtifactPanel module.
 ******************************************************************************/
function NextActionBanner({ nextAction }) {
  const meta = NEXT_ACTION_META[nextAction] ?? {
    icon: "mdi:information-outline",
    color: "border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300",
    label: nextAction?.replace(/_/g, " ") ?? "Unknown",
    desc: "",
  };
  return (
    <div className={`flex items-start gap-2 rounded-xl border p-3 text-xs ${meta.color}`}>
      <Icon icon={meta.icon} className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="font-bold">{meta.label}</p>
        {meta.desc && <p className="mt-0.5 opacity-80">{meta.desc}</p>}
      </div>
    </div>
  );
}

export { NextActionBanner };

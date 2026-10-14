import { useState } from "react";
import { Icon } from "@iconify/react";

// ── Risk badge colours ──────────────────────────────────────────────────────
const RISK_COLORS = {
  low: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  high: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  critical: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};
const METHOD_COLORS = {
  GET: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  POST: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
  PATCH: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300",
  PUT: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  DELETE: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
};

/*******************************************************************************
 * Function: Pill
 *
 * Performs the Pill operation on the application for the ChatArtifactPanel module.
 ******************************************************************************/
function Pill({ children, color = "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300" }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold leading-4 ${color}`}>
      {children}
    </span>
  );
}

/*******************************************************************************
 * Function: SectionHeader
 *
 * Performs the Section Header operation on header for the ChatArtifactPanel module.
 ******************************************************************************/
function SectionHeader({ icon, label, count }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <Icon icon={icon} className="h-4 w-4 text-primary" />
      <h4 className="text-xs font-bold uppercase tracking-widest text-gray-500 dark:text-gray-400">{label}</h4>
      {count !== undefined && (
        <span className="ml-auto rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">
          {count}
        </span>
      )}
    </div>
  );
}

// ── Collapsible wrapper ─────────────────────────────────────────────────────
/*******************************************************************************
 * Function: Collapsible
 *
 * Performs the Collapsible operation on the application for the ChatArtifactPanel module.
 ******************************************************************************/
function Collapsible({ title, icon, count, defaultOpen = false, children, badge }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border border-gray-100 dark:border-gray-800">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        <Icon icon={icon} className="h-4 w-4 shrink-0 text-primary" />
        <span className="flex-1 text-xs font-bold text-gray-800 dark:text-gray-100">{title}</span>
        {badge}
        {count !== undefined && (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-500 dark:bg-gray-800 dark:text-gray-400">
            {count}
          </span>
        )}
        <Icon
          icon={open ? "mdi:chevron-up" : "mdi:chevron-down"}
          className="h-4 w-4 text-gray-400"
        />
      </button>
      {open && <div className="border-t border-gray-100 px-3 pb-3 pt-2 dark:border-gray-800">{children}</div>}
    </div>
  );
}

export { Collapsible, METHOD_COLORS, Pill, RISK_COLORS, SectionHeader };

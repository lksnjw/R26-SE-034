import React from "react";

/*******************************************************************************
 * Function: BuilderModeControls
 *
 * Performs the Builder Mode Controls operation on mode controls for the BuilderModeControls module.
 ******************************************************************************/
export default function BuilderModeControls({ readOnly = false, isExecuting, isValidating, onValidate, onDeploy, onRun }) {
  if (readOnly) return React.createElement("span", { className: "text-xs text-gray-500" }, "Read-only preview");
  return React.createElement(
    "div",
    { className: "flex items-center gap-3" },
    React.createElement(
      "button",
      {
        type: "button",
        onClick: onValidate,
        disabled: isExecuting || isValidating,
        className: "inline-flex h-10 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60",
      },
      isValidating ? "Checking…" : "Check canvas"
    ),
    React.createElement(
      "button",
      {
        type: "button",
        onClick: onDeploy,
        disabled: isExecuting,
        className: "inline-flex h-10 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-bold text-slate-700 transition hover:bg-slate-50",
      },
      "Review & publish draft"
    ),
    React.createElement(
      "button",
      {
        type: "button",
        onClick: onRun,
        disabled: isExecuting,
        className: "inline-flex h-10 items-center rounded-lg bg-slate-950 px-4 text-sm font-bold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60",
      },
      isExecuting ? "Working…" : "Run published workflow"
    )
  );
}

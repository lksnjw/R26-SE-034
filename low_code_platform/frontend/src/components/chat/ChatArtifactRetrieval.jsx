import { useState } from "react";
import { Icon } from "@iconify/react";
import { METHOD_COLORS, Pill, RISK_COLORS } from "./ChatArtifactPrimitives";

// ── Tool card ───────────────────────────────────────────────────────────────
/*******************************************************************************
 * Function: ToolCard
 *
 * Performs the Tool Card operation on card for the ChatArtifactPanel module.
 ******************************************************************************/
function ToolCard({ tool }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50 p-2.5 text-xs dark:border-gray-800 dark:bg-darkBackgroundVery">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold text-gray-900 dark:text-white">{tool.display_name}</p>
          <p className="mt-0.5 font-mono text-[10px] text-gray-500">{tool.name}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Pill color={METHOD_COLORS[tool.http_method] ?? ""}>{tool.http_method}</Pill>
          <Pill color={RISK_COLORS[tool.risk_level]}>{tool.risk_level}</Pill>
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap gap-1">
        <Pill color="bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-300">
          {tool.erp_system}
        </Pill>
        {tool.bpi_process_alignment?.map((b) => (
          <Pill key={b} color="bg-violet-50 text-violet-600 dark:bg-violet-900/30 dark:text-violet-300">
            {b}
          </Pill>
        ))}
        <Pill color="bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
          {(tool.score * 100).toFixed(1)}%
        </Pill>
      </div>

      {tool.current_gaps?.length > 0 && (
        <p className="mt-1.5 text-[10px] italic text-amber-600 dark:text-amber-400">
          ⚠ {tool.current_gaps[0]}
        </p>
      )}

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="mt-1.5 text-[10px] font-semibold text-primary hover:underline"
      >
        {expanded ? "Hide details" : "Show details"}
      </button>

      {expanded && (
        <div className="mt-2 space-y-1.5 border-t border-gray-100 pt-2 dark:border-gray-800">
          <p className="text-gray-600 dark:text-gray-300">{tool.description}</p>
          <p className="font-mono text-[10px] text-gray-400">{tool.endpoint}</p>
          {tool.allowed_roles?.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {tool.allowed_roles.map((r) => (
                <Pill key={r} color="bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-300">
                  {r}
                </Pill>
              ))}
            </div>
          )}
          {tool.required_parameters?.length > 0 && (
            <p className="text-gray-500">
              Required: <span className="font-semibold">{tool.required_parameters.join(", ")}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Rule card ───────────────────────────────────────────────────────────────
const RULE_TYPE_COLORS = {
  rbac: "bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300",
  audit: "bg-purple-50 text-purple-600 dark:bg-purple-900/30 dark:text-purple-300",
  cache_safety: "bg-cyan-50 text-cyan-600 dark:bg-cyan-900/30 dark:text-cyan-300",
  execution_safety: "bg-orange-50 text-orange-600 dark:bg-orange-900/30 dark:text-orange-300",
  data_confidentiality: "bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-300",
  process_order: "bg-indigo-50 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-300",
};

const ACTION_ICON = {
  block: "mdi:block-helper",
  allow: "mdi:check-circle-outline",
  write_audit_log: "mdi:file-document-edit-outline",
  escalate_to_admin: "mdi:account-alert-outline",
  require_additional_tool: "mdi:tools",
};

/*******************************************************************************
 * Function: RuleCard
 *
 * Performs the Rule Card operation on card for the ChatArtifactPanel module.
 ******************************************************************************/
function RuleCard({ rule }) {
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50 p-2.5 text-xs dark:border-gray-800 dark:bg-darkBackgroundVery">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold text-gray-900 dark:text-white">{rule.rule_name}</p>
          <p className="mt-0.5 text-[10px] text-gray-400">{rule.rule_id}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Pill color={RULE_TYPE_COLORS[rule.rule_type] ?? ""}>{rule.rule_type}</Pill>
          <Pill color={RISK_COLORS[rule.severity]}>{rule.severity}</Pill>
        </div>
      </div>
      <p className="mt-1.5 text-gray-600 dark:text-gray-300 line-clamp-2">{rule.description}</p>
      <div className="mt-1.5 flex items-center gap-1.5">
        <Icon
          icon={ACTION_ICON[rule.enforcement_action] ?? "mdi:information-outline"}
          className={`h-3.5 w-3.5 ${rule.enforcement_action === "block" ? "text-red-500" : rule.enforcement_action === "allow" ? "text-emerald-500" : "text-amber-500"}`}
        />
        <span className={`text-[10px] font-semibold ${rule.enforcement_action === "block" ? "text-red-500" : rule.enforcement_action === "allow" ? "text-emerald-500" : "text-amber-500"}`}>
          {rule.enforcement_action?.replace(/_/g, " ")}
        </span>
        <span className="ml-auto text-[10px] text-gray-400">
          Score: {(rule.score * 100).toFixed(0)}%
        </span>
      </div>
    </div>
  );
}

// ── Example card ────────────────────────────────────────────────────────────
const DECISION_COLORS = {
  block: "text-red-600 dark:text-red-400",
  allow: "text-emerald-600 dark:text-emerald-400",
};

/*******************************************************************************
 * Function: ExampleCard
 *
 * Performs the Example Card operation on card for the ChatArtifactPanel module.
 ******************************************************************************/
function ExampleCard({ example }) {
  return (
    <div className="rounded-lg border border-gray-100 bg-gray-50 p-2.5 text-xs dark:border-gray-800 dark:bg-darkBackgroundVery">
      <div className="flex items-start justify-between gap-2">
        <p className="italic text-gray-700 dark:text-gray-200 line-clamp-2">"{example.user_request}"</p>
        <Pill color={RISK_COLORS[example.risk_level]}>{example.risk_level}</Pill>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1 text-[10px] text-gray-500">
        <span>Role: <strong>{example.user_role}</strong></span>
        <span>·</span>
        <span className={`font-bold ${DECISION_COLORS[example.expected_decision] ?? ""}`}>
          {example.expected_decision}
        </span>
        <span>·</span>
        <span>{example.expected_domain}</span>
      </div>
    </div>
  );
}

export { ExampleCard, RuleCard, ToolCard };

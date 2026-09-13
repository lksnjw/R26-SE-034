import { Icon } from "@iconify/react";
import ReadableValue from "./ReadableValue";
import { Collapsible } from "./ChatArtifactPrimitives";

// ── MAIN COMPONENT ──────────────────────────────────────────────────────────
// ── Simple inline bar chart ─────────────────────────────────────────────────
/*******************************************************************************
 * Function: MiniBarChart
 *
 * Performs the Mini Bar Chart operation on bar chart for the ChatArtifactPanel module.
 ******************************************************************************/
function MiniBarChart({ vis }) {
  if (!vis || !Array.isArray(vis.data) || vis.data.length === 0) return null;
/*******************************************************************************
 * Function: max
 *
 * Performs the max operation on the application for the ChatArtifactPanel module.
 ******************************************************************************/
  const max = Math.max(...vis.data.map((d) => d.value), 1);
  return (
    <div className="mt-2 rounded-xl border border-gray-100 bg-white p-3 dark:border-gray-800 dark:bg-darkBackground">
      <p className="mb-2 text-xs font-semibold text-gray-700 dark:text-gray-300">{vis.title}</p>
      <div className="space-y-1.5">
        {vis.data.map((d, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <span className="w-24 shrink-0 truncate text-right text-gray-500 dark:text-gray-400">{d.label}</span>
            <div className="flex-1 rounded-full bg-gray-100 dark:bg-gray-800" style={{ height: 8 }}>
              <div
                className="rounded-full bg-primary"
                style={{ width: `${(d.value / max) * 100}%`, height: 8 }}
              />
            </div>
            <span className="w-10 shrink-0 text-right font-semibold text-gray-700 dark:text-gray-300">{d.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Query / Audit result panel ──────────────────────────────────────────────
/*******************************************************************************
 * Function: QueryResultPanel
 *
 * Performs the Query Result Panel operation on result panel for the ChatArtifactPanel module.
 ******************************************************************************/
export function QueryResultPanel({ artifact }) {
  const sources = Array.isArray(artifact.sources) ? artifact.sources : [];
  const { visualisation, boundHit, iterationsUsed, latencyMs, intent, stopReason } = artifact;
  const stopMessage = stopReason === "LIMIT_REACHED"
    ? "Preparation reached a configured bound. Saved results may be partial."
    : stopReason === "PROVIDER_FAILED"
      ? "Preparation stopped because the configured model provider failed. Saved read receipts may be partial."
      : stopReason === "CANCELLED"
        ? "Preparation was cancelled. Saved read receipts may be partial."
        : "Preparation stopped before a complete answer was produced. Saved results may be partial.";

  return (
    <div className="space-y-3">
      {/* ── Intent badge ── */}
      <div className="flex items-center gap-2 rounded-xl border border-blue-100 bg-blue-50 px-3 py-2 dark:border-blue-900/40 dark:bg-blue-900/20">
        <Icon icon={intent === "AUDIT" ? "mdi:magnify-scan" : "mdi:database-search-outline"} className="h-4 w-4 text-blue-500" />
        <span className="text-xs font-bold text-blue-700 dark:text-blue-300">{intent === "AUDIT" ? "Audit Query" : "Data Query"}</span>
        {typeof iterationsUsed === "number" && (
          <span className="ml-auto text-[10px] text-blue-500">{iterationsUsed} tool call{iterationsUsed !== 1 ? "s" : ""}</span>
        )}
        {typeof latencyMs === "number" && (
          <span className="text-[10px] text-blue-400">{(latencyMs / 1000).toFixed(1)}s</span>
        )}
      </div>

      {/* ── Bound hit warning ── */}
      {boundHit && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-800/40 dark:bg-amber-900/20 dark:text-amber-300">
          <Icon icon="mdi:alert-outline" className="h-4 w-4 shrink-0" />
          {stopMessage}
        </div>
      )}

      {/* ── Visualisation ── */}
      {visualisation && <MiniBarChart vis={visualisation} />}

      {/* ── Sources ── */}
      {sources.length > 0 && (
        <Collapsible title="Sources" icon="mdi:api" count={sources.length}>
          <div className="space-y-1.5">
            {sources.map((call, i) => (
              <div key={i} className="rounded-lg border border-gray-100 bg-gray-50 p-2 text-xs dark:border-gray-800 dark:bg-darkBackgroundVery">
                <p className="font-mono font-semibold text-gray-800 dark:text-white">{call.name}</p>
                {Object.keys(call.arguments ?? {}).length > 0 && (
                  <div className="mt-2"><ReadableValue value={call.arguments} /></div>
                )}
              </div>
            ))}
          </div>
        </Collapsible>
      )}
    </div>
  );
}

export default QueryResultPanel;

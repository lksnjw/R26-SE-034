import { Icon } from "@iconify/react";

const bridgeStats = [
  { label: "ERP Bridge Status", value: "Ready", detail: "MCP gateway awaiting backend wiring" },
  { label: "Registered Tools", value: "20", detail: "Matches current tool schema catalog" },
  { label: "Target Runtime", value: "Go Fiber", detail: "Backend bridge API integration point" },
];

const bridgeTasks = [
  "Map frontend tool calls to MCP bridge endpoints",
  "Show live ERP connector health and latency",
  "Display request/response payload previews",
  "Add retry and self-healing event visibility",
];

function McpBridgePage() {
  return (
    <div className="space-y-6">
      <section className="flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
            Separate Member Section
          </p>
          <h1 className="page-heading mt-3 text-gray-950 dark:text-white">MCP Bridge</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-500 dark:text-gray-400">
            Dedicated workspace for the ERP Bridge and MCP Server integration work. This page is
            intentionally isolated so the bridge team can evolve it without changing existing
            workflow, chat, or analytics pages.
          </p>
        </div>
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-green-200 bg-green-50 px-4 py-2 text-sm font-bold text-green-700 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-300">
          <Icon icon="mdi:lan-connect" className="h-5 w-5" />
          Bridge page created
        </span>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {bridgeStats.map((stat) => (
          <div
            key={stat.label}
            className="surface-panel rounded-2xl p-5"
          >
            <p className="text-sm font-semibold text-gray-500 dark:text-gray-400">{stat.label}</p>
            <p className="mt-3 text-3xl font-black text-gray-950 dark:text-white">{stat.value}</p>
            <p className="mt-2 text-sm leading-6 text-gray-500 dark:text-gray-400">{stat.detail}</p>
          </div>
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="surface-panel rounded-2xl p-5">
          <h2 className="section-title">Bridge Integration Scope</h2>
          <div className="mt-5 grid gap-3">
            {bridgeTasks.map((task) => (
              <div
                key={task}
                className="flex items-start gap-3 rounded-xl border border-gray-200 bg-backgroundLight p-4 dark:border-gray-800 dark:bg-darkBackgroundVery"
              >
                <Icon icon="mdi:check-circle-outline" className="mt-0.5 h-5 w-5 text-primary" />
                <p className="text-sm leading-6 text-gray-600 dark:text-gray-300">{task}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="surface-panel rounded-2xl p-5">
          <h2 className="section-title">Backend Contract Placeholder</h2>
          <div className="mt-5 rounded-xl bg-gray-950 p-4 font-mono text-xs leading-6 text-gray-100">
            <p>POST /api/mcp/tools/execute</p>
            <p>GET /api/mcp/tools</p>
            <p>GET /api/mcp/health</p>
            <p>POST /api/mcp/retry</p>
          </div>
          <p className="mt-4 text-sm leading-6 text-gray-500 dark:text-gray-400">
            Replace these placeholders with the final bridge endpoints when the MCP backend team is
            ready.
          </p>
        </div>
      </section>
    </div>
  );
}

export default McpBridgePage;

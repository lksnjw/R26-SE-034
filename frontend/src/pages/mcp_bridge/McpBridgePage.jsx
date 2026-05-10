import { useState } from "react";
import { Icon } from "@iconify/react";

const initialTools = [
  { id: "SAP_PO_CREATE", name: "Create Purchase Order", system: "SAP S/4HANA", status: "Active" },
  { id: "ORACLE_INV_READ", name: "Fetch Invoice Details", system: "Oracle ERP", status: "Active" },
  { id: "SF_LEAD_UPDATE", name: "Update Lead Record", system: "Salesforce", status: "Maintenance" },
];

const mockLogs = [
  "[17:10:01 INFO] MCP Server started on port 9090",
  "[17:10:02 INFO] Establishing connection to SAP S/4HANA...",
  "[17:10:03 INFO] SAP S/4HANA connection established successfully.",
  "[17:10:05 INFO] Registered 3 tools in the global registry.",
  "[17:12:30 WARN] Salesforce API latency spike detected (>500ms).",
  "[17:13:45 INFO] Executing SAP_PO_CREATE payload for user system.",
  "[17:13:47 INFO] Execution successful. Response payload returned.",
];

function McpBridgePage() {
  const [tools, setTools] = useState(initialTools);
  const [isAddingTool, setIsAddingTool] = useState(false);
  const [newToolName, setNewToolName] = useState("");
  const [newToolSystem, setNewToolSystem] = useState("SAP S/4HANA");

  const handleAddTool = (e) => {
    e.preventDefault();
    if (newToolName.trim() === "") return;
    
    const newTool = {
      id: newToolName.toUpperCase().replace(/\s+/g, "_"),
      name: newToolName,
      system: newToolSystem,
      status: "Active",
    };
    
    setTools([newTool, ...tools]);
    setIsAddingTool(false);
    setNewToolName("");
  };

  return (
    <div className="space-y-6 pb-10">
      <section className="flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
            Infrastructure & Integration
          </p>
          <h1 className="page-heading mt-3 text-gray-950 dark:text-white">MCP Bridge Dashboard</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-500 dark:text-gray-400">
            Manage your Model Context Protocol (MCP) server integration. Monitor live logs, manage the remote tool registry, and configure connection parameters for your ERP systems.
          </p>
        </div>
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-green-200 bg-green-50 px-4 py-2 text-sm font-bold text-green-700 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-300">
          <Icon icon="mdi:server-network" className="h-5 w-5" />
          Server Online
        </span>
      </section>

      {/* Server Status Overview */}
      <section className="grid gap-4 md:grid-cols-4">
        <div className="surface-panel rounded-2xl p-5">
          <p className="text-sm font-semibold text-gray-500 dark:text-gray-400">Status</p>
          <div className="mt-2 flex items-center gap-2">
            <div className="h-2.5 w-2.5 rounded-full bg-emerald-500"></div>
            <p className="text-2xl font-black text-gray-950 dark:text-white">Healthy</p>
          </div>
        </div>
        <div className="surface-panel rounded-2xl p-5">
          <p className="text-sm font-semibold text-gray-500 dark:text-gray-400">Active ERP Connectors</p>
          <p className="mt-2 text-2xl font-black text-gray-950 dark:text-white">3</p>
        </div>
        <div className="surface-panel rounded-2xl p-5">
          <p className="text-sm font-semibold text-gray-500 dark:text-gray-400">Avg Latency</p>
          <p className="mt-2 text-2xl font-black text-gray-950 dark:text-white">124ms</p>
        </div>
        <div className="surface-panel rounded-2xl p-5">
          <p className="text-sm font-semibold text-gray-500 dark:text-gray-400">Uptime</p>
          <p className="mt-2 text-2xl font-black text-gray-950 dark:text-white">99.98%</p>
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        {/* Tool Registry */}
        <section className="surface-panel flex flex-col rounded-2xl p-6">
          <div className="flex items-center justify-between border-b border-gray-100 pb-4 dark:border-gray-800">
            <h2 className="section-title flex items-center gap-2">
              <Icon icon="mdi:toolbox" className="h-5 w-5 text-primary" />
              Tool Registry
            </h2>
            <button 
              onClick={() => setIsAddingTool(!isAddingTool)}
              className="rounded-lg bg-primary/10 px-3 py-1.5 text-xs font-bold text-primary hover:bg-primary/20 dark:bg-primary/20 dark:hover:bg-primary/30"
            >
              {isAddingTool ? "Cancel" : "+ Add Tool"}
            </button>
          </div>

          {isAddingTool && (
            <form onSubmit={handleAddTool} className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-darkBackground">
              <div className="grid gap-3">
                <div>
                  <label className="mb-1 text-xs font-bold text-gray-700 dark:text-gray-300">Tool Name</label>
                  <input 
                    type="text" 
                    value={newToolName}
                    onChange={(e) => setNewToolName(e.target.value)}
                    placeholder="e.g. Fetch Customer Data"
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-primary focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 text-xs font-bold text-gray-700 dark:text-gray-300">Target System</label>
                  <select 
                    value={newToolSystem}
                    onChange={(e) => setNewToolSystem(e.target.value)}
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-primary focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                  >
                    <option>SAP S/4HANA</option>
                    <option>Oracle ERP</option>
                    <option>Salesforce</option>
                    <option>Workday</option>
                  </select>
                </div>
                <button type="submit" className="mt-2 w-full rounded-lg bg-primary py-2 text-sm font-bold text-white hover:bg-primary/90">
                  Register Tool
                </button>
              </div>
            </form>
          )}

          <div className="mt-4 flex-1 overflow-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-100 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
                  <th className="pb-2 font-medium">Tool ID</th>
                  <th className="pb-2 font-medium">System</th>
                  <th className="pb-2 text-right font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                {tools.map((tool) => (
                  <tr key={tool.id}>
                    <td className="py-3">
                      <p className="font-bold text-gray-900 dark:text-white">{tool.name}</p>
                      <p className="font-mono text-[10px] text-gray-500">{tool.id}</p>
                    </td>
                    <td className="py-3 text-gray-600 dark:text-gray-300">{tool.system}</td>
                    <td className="py-3 text-right">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        tool.status === "Active" 
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" 
                          : "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                      }`}>
                        {tool.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="space-y-6">
          {/* Configurations */}
          <section className="surface-panel rounded-2xl p-6">
            <h2 className="section-title flex items-center gap-2 border-b border-gray-100 pb-4 dark:border-gray-800">
              <Icon icon="mdi:cog-outline" className="h-5 w-5 text-primary" />
              Bridge Configurations
            </h2>
            <div className="mt-4 space-y-4">
              <div>
                <label className="mb-1 block text-sm font-semibold text-gray-800 dark:text-gray-200">
                  MCP Server URL
                </label>
                <input 
                  type="text" 
                  defaultValue="http://mcp-bridge.internal:9090" 
                  className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm font-mono text-gray-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary dark:border-gray-700 dark:bg-darkBackground dark:text-white" 
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="mb-1 block text-sm font-semibold text-gray-800 dark:text-gray-200">
                    Timeout (ms)
                  </label>
                  <input 
                    type="number" 
                    defaultValue={5000} 
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary dark:border-gray-700 dark:bg-darkBackground dark:text-white" 
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-semibold text-gray-800 dark:text-gray-200">
                    Max Retries
                  </label>
                  <input 
                    type="number" 
                    defaultValue={3} 
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary dark:border-gray-700 dark:bg-darkBackground dark:text-white" 
                  />
                </div>
              </div>
              <button className="mt-2 w-full rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-bold text-white transition-colors hover:bg-gray-800 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200">
                Save Configurations
              </button>
            </div>
          </section>

          {/* Live Logs */}
          <section className="surface-panel flex flex-col rounded-2xl p-6">
            <div className="flex items-center justify-between border-b border-gray-100 pb-4 dark:border-gray-800">
              <h2 className="section-title flex items-center gap-2">
                <Icon icon="mdi:console" className="h-5 w-5 text-primary" />
                Live Terminal Logs
              </h2>
              <div className="flex gap-1.5">
                <span className="h-3 w-3 rounded-full bg-red-500"></span>
                <span className="h-3 w-3 rounded-full bg-amber-500"></span>
                <span className="h-3 w-3 rounded-full bg-emerald-500"></span>
              </div>
            </div>
            <div className="mt-4 h-48 overflow-y-auto rounded-xl bg-[#0d1117] p-4 font-mono text-[11px] leading-5 text-gray-300">
              {mockLogs.map((log, index) => (
                <div key={index} className={log.includes("WARN") ? "text-amber-400" : log.includes("ERROR") ? "text-red-400" : ""}>
                  {log}
                </div>
              ))}
              <div className="animate-pulse text-primary">_</div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export default McpBridgePage;

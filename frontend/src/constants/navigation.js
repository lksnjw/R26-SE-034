export const NAVIGATION_GROUPS = [
  {
    id: "dashboard",
    label: "Dashboard",
    description: "Operational overview",
    icon: "mdi:chart-pie",
    subMenu: [
      { id: "overview", label: "Overview" },
      { id: "activity", label: "Activity" },
    ],
  },
  {
    id: "workflows",
    label: "Workflows",
    description: "Blueprints and builder",
    icon: "tabler:git-branch",
    subMenu: [
      { id: "list", label: "All Workflows" },
      { id: "builder", label: "Flow Builder" },
      { id: "templates", label: "Templates" },
      { id: "detail", label: "Runbook Detail" },
    ],
  },
  {
    id: "chat",
    label: "Agent Chat",
    description: "Natural language synthesis",
    icon: "hugeicons:ai-magic",
    subMenu: [
      { id: "session", label: "Synthesis Chat" },
      { id: "history", label: "Chat History" },
    ],
  },
  {
    id: "executions",
    label: "Executions",
    description: "Runs, logs, and healing",
    icon: "mdi:play-circle-outline",
    subMenu: [
      { id: "history", label: "Run History" },
      { id: "live", label: "Live Logs", hasNotification: true },
      { id: "healing", label: "Healing Events" },
    ],
  },
  {
    id: "analytics",
    label: "Analytics",
    description: "Performance and cost",
    icon: "mdi:chart-bar",
    subMenu: [
      { id: "performance", label: "Performance" },
      { id: "usage", label: "Usage & Cost" },
      { id: "healing", label: "Self-Healing" },
    ],
  },
  {
    id: "users",
    label: "Users",
    description: "Roles and audit trails",
    icon: "solar:users-group-rounded-linear",
    subMenu: [
      { id: "directory", label: "Directory" },
      { id: "roles", label: "Roles" },
      { id: "audit", label: "Audit Logs" },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    description: "Platform configuration",
    icon: "mdi:cog-outline",
    subMenu: [
      { id: "general", label: "General" },
      { id: "integrations", label: "Integrations" },
      { id: "llm", label: "LLM Policy" },
    ],
  },
  {
    id: "mcp_bridge",
    label: "MCP Bridge",
    description: "ERP bridge integration",
    icon: "mdi:lan-connect",
    subMenu: [{ id: "overview", label: "Bridge Overview", path: "/mcp-bridge" }],
  },
  {
    id: "datafeed",
    label: "Datafeed",
    description: "Vector DB & Pipeline",
    icon: "mdi:database-sync-outline",
    subMenu: [
      { id: "overview", label: "Pipeline Status" },
      { id: "metrics", label: "Vector Metrics" },
      { id: "config", label: "Configuration" }
    ],
  },
  {
    id: "finetune",
    label: "ERP Models",
    description: "ERP data & queries",
    icon: "mdi:robot-industrial",
    subMenu: [{ id: "overview", label: "Model Integration", path: "/finetune" }],
  },
  {
    id: "profile",
    label: "Profile",
    description: "Account and security",
    icon: "solar:user-linear",
    subMenu: [
      { id: "profile", label: "My Profile" },
      { id: "security", label: "Security" },
    ],
  },
];

export const DEFAULT_ROUTE = {
  main: "dashboard",
  sub: "overview",
};

export const getNavigationGroup = (id) =>
  NAVIGATION_GROUPS.find((group) => group.id === id) ?? NAVIGATION_GROUPS[0];

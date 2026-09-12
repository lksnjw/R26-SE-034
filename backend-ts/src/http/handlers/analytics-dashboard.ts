import type { FastifyReply, FastifyRequest } from "fastify";
import { ok } from "../../models/schemas.js";
import type { RouteDefinition } from "../generated-routes.js";
import {
  HandlerFailure,
  type HandlerServices,
  isRecord,
  numberValue,
  queryRecord,
  stringValue,
} from "./common.js";

export const ANALYTICS_DASHBOARD_UNHANDLED = Symbol("analytics-dashboard-unhandled");

/** Owns API-only runtime analytics and dashboard compatibility reads. */
export async function handleAnalyticsDashboardRoute(
  route: RouteDefinition,
  request: FastifyRequest,
  reply: FastifyReply,
  services: HandlerServices,
): Promise<unknown | typeof ANALYTICS_DASHBOARD_UNHANDLED> {
  const base = services.config.apiBasePath;
  if (route.path.startsWith(`${base}/analytics/`)) {
    return analytics(
      route.path.slice(`${base}/analytics/`.length),
      request,
      reply,
      services,
    );
  }
  if (route.path === `${base}/dashboard/summary`)
    return dashboardSummary(request, reply, services);
  if (route.path === `${base}/dashboard/activity`)
    return dashboardActivity(reply, services);
  if (route.path === `${base}/dashboard/health`)
    return dashboardHealth(reply, services);
  if (route.path === `${base}/dashboard/recent-workflows`)
    return recentWorkflows(request, reply, services);
  return ANALYTICS_DASHBOARD_UNHANDLED;
}

async function analytics(
  kind: string,
  request: FastifyRequest,
  reply: FastifyReply,
  services: HandlerServices,
): Promise<unknown> {
  const executions = await services.repository.read((state) =>
    Object.values(state.executions),
  );
  if (kind === "summary") {
    const today = utcDate(new Date());
    const todayRuns = executions.filter(
      (item) => item.startedAt.slice(0, 10) === today,
    );
    const done = executions.filter((item) => item.status === "DONE").length;
    const terminal = executions.filter(
      (item) => item.status === "DONE" || item.status === "FAILED",
    ).length;
    return reply.send(
      ok(
        {
          runsToday: todayRuns.length,
          avgLatencyMs: average(executions.map((item) => item.durationMs)),
          tokenCostUsd: sum(executions.map((item) => item.costUsd)),
          projectedMonthlyCostUsd: 0,
          successRate: terminal === 0 ? 0 : round((done * 100) / terminal),
          healingSuccessRate: 0,
          validationF1Score: null,
          validationMetricsAvailable: false,
        },
        "OK",
        {
          range:
            stringValue(queryRecord(request).range).trim() === ""
              ? "7d"
              : stringValue(queryRecord(request).range),
        },
      ),
    );
  }
  if (kind === "performance") {
    return reply.send(
      ok(
        daySeries(7).map((day) => {
          const values = executions.filter(
            (item) => item.startedAt.slice(0, 10) === day,
          );
          const terminal = values.filter(
            (item) => item.status === "DONE" || item.status === "FAILED",
          );
          return {
            label: day,
            runs: values.length,
            successRate:
              terminal.length === 0
                ? 0
                : round(
                    (terminal.filter((item) => item.status === "DONE").length *
                      100) /
                      terminal.length,
                  ),
            avgLatencyMs: average(values.map((item) => item.durationMs)),
            p95LatencyMs: percentile(
              values.map((item) => item.durationMs),
              0.95,
            ),
          };
        }),
        "OK",
        { interval: "day" },
      ),
    );
  }
  if (kind === "usage") {
    return reply.send(
      ok(
        daySeries(7).map((day) => {
          const values = executions.filter(
            (item) => item.startedAt.slice(0, 10) === day,
          );
          return {
            label: day,
            inputTokens: sum(values.map((item) => item.tokens.input)),
            outputTokens: sum(values.map((item) => item.tokens.output)),
            totalTokens: sum(values.map((item) => item.tokens.total)),
            costUsd: sum(values.map((item) => item.costUsd)),
          };
        }),
        "OK",
        { currency: "USD" },
      ),
    );
  }
  if (kind === "self-healing") {
    const reports = await services.repository.read((state) =>
      Object.values(state.healing),
    );
    const recovered = reports.filter(
      (item) => item.status === "VALIDATED_REPAIR_AVAILABLE",
    ).length;
    return reply.send(
      ok(
        {
          successRate:
            reports.length === 0
              ? 0
              : round((recovered * 100) / reports.length),
          attempts: reports.length,
          recovered,
          failed: reports.length - recovered,
          byReason: [],
        },
        "OK",
        null,
      ),
    );
  }
  if (kind === "latency") {
    const buckets = [
      { bucket: "0-500ms", min: 0, max: 500 },
      { bucket: "500ms-1s", min: 500, max: 1000 },
      { bucket: "1s-2s", min: 1000, max: 2000 },
      { bucket: "2s-5s", min: 2000, max: 5000 },
      { bucket: "5s+", min: 5000, max: Number.POSITIVE_INFINITY },
    ];
    return reply.send(
      ok(
        buckets.map(({ bucket, min, max }) => ({
          bucket,
          count: executions.filter(
            (item) => item.durationMs >= min && item.durationMs < max,
          ).length,
        })),
        "OK",
        null,
      ),
    );
  }
  if (kind === "f1-score") {
    return reply.send(
      ok(
        {
          available: false,
          score: null,
          precision: null,
          recall: null,
          samples: 0,
          falsePositives: 0,
          falseNegatives: 0,
        },
        "No runtime validation benchmark has been recorded",
        null,
      ),
    );
  }
  if (kind === "activity-heatmap") {
    return reply.send(
      ok(
        daySeries(14).map((date) => {
          const count = executions.filter(
            (item) => item.startedAt.slice(0, 10) === date,
          ).length;
          return { date, count, intensity: Math.min(4, count) };
        }),
        "OK",
        { timezone: "UTC" },
      ),
    );
  }
  if (kind === "cost-trends") {
    return reply.send(
      ok(
        daySeries(7).map((label) => ({
          label,
          costUsd: sum(
            executions
              .filter((item) => item.startedAt.slice(0, 10) === label)
              .map((item) => item.costUsd),
          ),
        })),
        "OK",
        { interval: "day" },
      ),
    );
  }
  throw new HandlerFailure(404, "Resource not found");
}

async function dashboardSummary(
  request: FastifyRequest,
  reply: FastifyReply,
  services: HandlerServices,
): Promise<unknown> {
  const state = await services.repository.snapshot();
  const workflows = Object.values(state.workflows).filter((item) => !item.archived);
  const executions = Object.values(state.executions);
  const terminal = executions.filter(
    (item) => item.status === "DONE" || item.status === "FAILED",
  );
  const successRate =
    terminal.length === 0
      ? 0
      : round(
          (terminal.filter((item) => item.status === "DONE").length * 100) /
            terminal.length,
        );
  const cost = sum(executions.map((item) => item.costUsd));
  const metrics = [
    {
      key: "workflows",
      label: "Workflows",
      value: workflows.length,
      formattedValue: String(workflows.length),
      delta: "",
      trend: "neutral",
      icon: "workflow",
      tone: "blue",
    },
    {
      key: "executions",
      label: "Executions",
      value: executions.length,
      formattedValue: String(executions.length),
      delta: "",
      trend: "neutral",
      icon: "play",
      tone: "purple",
    },
    {
      key: "successRate",
      label: "Success rate",
      value: successRate,
      formattedValue: `${successRate}%`,
      delta: "",
      trend: "neutral",
      icon: "check",
      tone: "green",
    },
    {
      key: "cost",
      label: "Cost",
      value: cost,
      formattedValue: `$${cost.toFixed(2)}`,
      delta: "",
      trend: "neutral",
      icon: "dollar",
      tone: "amber",
    },
  ];
  const query = queryRecord(request);
  return reply.send(
    ok(
      { metrics },
      "OK",
      {
        range:
          stringValue(query.range).trim() === ""
            ? "7d"
            : stringValue(query.range),
        timezone:
          stringValue(query.timezone).trim() === ""
            ? "UTC"
            : stringValue(query.timezone),
      },
    ),
  );
}

async function dashboardActivity(
  reply: FastifyReply,
  services: HandlerServices,
): Promise<unknown> {
  const state = await services.repository.snapshot();
  const audit = state.auditLogs.filter(isRecord).map((item) => ({
    id: item.id,
    type: "audit",
    title: item.action,
    timestamp: item.createdAt,
    data: item,
  }));
  const executions = Object.values(state.executions).map((item) => ({
    id: item.id,
    type: "execution",
    title: `${item.workflowName} ${item.status.toLowerCase()}`,
    timestamp: item.startedAt,
    data: item,
  }));
  const items = [...audit, ...executions]
    .sort((a, b) =>
      stringValue(b.timestamp).localeCompare(stringValue(a.timestamp)),
    )
    .slice(0, 20);
  return reply.send(ok(items, "OK", { nextCursor: null }));
}

async function dashboardHealth(
  reply: FastifyReply,
  services: HandlerServices,
): Promise<unknown> {
  const storage = await services.repository.persistenceStatus();
  const checked = new Date().toISOString();
  const mcpEndpoint =
    services.config.mcpTransport === "erpbridge-mcp"
      ? services.config.erpbridgeBaseURL
      : services.config.mcpBaseURL;
  const mcpConfigured = services.config.mcpMode === "mock" || mcpEndpoint !== "";
  const servicesList = [
    {
      name: "API",
      status: "healthy",
      value: 100,
      meta: "Operational",
      lastCheckedAt: checked,
    },
    {
      name: "Storage",
      status: storage.healthy ? "healthy" : "unhealthy",
      value: storage.healthy ? 100 : 0,
      meta: storage.durable ? "Durable" : "Memory",
      lastCheckedAt: checked,
    },
    {
      name: "MCP Bridge",
      status: mcpConfigured ? "healthy" : "degraded",
      value: mcpConfigured ? 100 : 0,
      meta: mcpEndpoint || "mock",
      lastCheckedAt: checked,
    },
  ];
  return reply.send(
    ok(
      {
        overall: servicesList.every((item) => item.status === "healthy")
          ? "healthy"
          : "degraded",
        services: servicesList,
      },
      "OK",
      null,
    ),
  );
}

async function recentWorkflows(
  request: FastifyRequest,
  reply: FastifyReply,
  services: HandlerServices,
): Promise<unknown> {
  const limit = numberValue(queryRecord(request).limit, 5);
  const workflows = await services.repository.read((state) =>
    Object.values(state.workflows)
      .filter((item) => !item.archived)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit <= 0 ? undefined : limit)
      .map(({ yaml: _yaml, archived: _archived, canvas: _canvas, ...item }) => item),
  );
  return reply.send(ok(workflows, "OK", null));
}

function daySeries(count: number): string[] {
  const values: string[] = [];
  const current = new Date();
  current.setUTCHours(0, 0, 0, 0);
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(current);
    date.setUTCDate(current.getUTCDate() - offset);
    values.push(utcDate(date));
  }
  return values;
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : Math.trunc(sum(values) / values.length);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

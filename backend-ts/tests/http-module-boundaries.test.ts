import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const source = (path: string) => readFile(resolve(path), "utf8");

describe("HTTP responsibility boundaries", () => {
  test("keeps the application composition root below the agreed size ceiling", async () => {
    const app = await source("src/http/app.ts");
    expect(app.split(/\r?\n/).length).toBeLessThanOrEqual(650);
  });

  test("keeps authentication/session cryptography out of the route composition root", async () => {
    const [app, authentication] = await Promise.all([
      source("src/http/app.ts"),
      source("src/http/handlers/authentication.ts"),
    ]);
    expect(app).not.toMatch(/function\s+(?:authenticate|login|register|refresh|issueSession)\b/);
    expect(app).not.toContain("jsonwebtoken");
    expect(app).not.toContain("hashPassword");
    expect(authentication).toContain("export async function authenticate");
    expect(authentication).toContain("async function issueSession");
  });

  test("owns the shared service contract and malformed-body sentinel in dedicated modules", async () => {
    const [app, services, requestBody] = await Promise.all([
      source("src/http/app.ts"),
      source("src/http/application-services.ts"),
      source("src/http/request-body.ts"),
    ]);
    expect(app).not.toMatch(/export type ApplicationServices\s*=\s*\{/);
    expect(services).toMatch(/export type ApplicationServices\s*=\s*\{/);
    expect(requestBody).toContain("export const INVALID_JSON_BODY");
  });

  test("keeps workflow lifecycle and admission out of the route composition root", async () => {
    const [app, workflowRuntime, executionRoutes] = await Promise.all([
      source("src/http/app.ts"),
      source("src/http/handlers/workflow-runtime.ts"),
      source("src/http/handlers/uploads-executions.ts"),
    ]);
    expect(app).not.toMatch(/function\s+(?:createWorkflow|runWorkflowFor|resumeWorkflowApproval)\b/);
    expect(workflowRuntime).toContain("export async function runWorkflowFor");
    expect(executionRoutes).toContain('from "./workflow-runtime.js"');
    expect(executionRoutes).not.toContain('from "../app.js"');
  });

  test("keeps authenticated execution event waiting in its dedicated handler", async () => {
    const [executionControl, executionEvents] = await Promise.all([
      source("src/http/handlers/execution-control.ts"),
      source("src/http/handlers/execution-events.ts"),
    ]);
    expect(executionControl).toContain('from "./execution-events.js"');
    expect(executionControl).not.toContain("observeCommits");
    expect(executionEvents).toContain("export async function handleExecutionEvents");
    expect(executionEvents).toContain("repository.observeCommits");
    expect(executionEvents).toContain("repository.readAuthoritative");
  });

  test("separates access, socket, execution-query and notification responsibilities", async () => {
    const [app, policy, socket, executionQueries, notifications, administration] = await Promise.all([
      source("src/http/app.ts"),
      source("src/http/route-policy.ts"),
      source("src/http/system-health-websocket.ts"),
      source("src/http/handlers/execution-queries.ts"),
      source("src/http/handlers/notifications.ts"),
      source("src/http/handlers/administration.ts"),
    ]);
    expect(app).not.toMatch(/function\s+(?:routePolicy|sendWebsocketSnapshot|listExecutions|getExecution|listNotifications|markNotificationRead)\b/);
    expect(policy).toContain("export function routePolicy");
    expect(socket).toContain("export function attachSystemHealthSocket");
    expect(executionQueries).toContain("export async function handleExecutionQueryRoute");
    expect(notifications).toContain("export async function handleNotificationRoute");
    expect(administration).not.toContain("function listNotifications");
  });

  test("keeps the resource dispatcher thin and delegates domain behavior", async () => {
    const [resources, chat, company, providers, settingsIntegrations, chatJobs] = await Promise.all([
      source("src/http/handlers/resources.ts"),
      source("src/http/handlers/chat.ts"),
      source("src/http/handlers/company.ts"),
      source("src/http/handlers/providers.ts"),
      source("src/http/handlers/settings-integrations.ts"),
      source("src/agent/chat-jobs.ts"),
    ]);
    expect(resources.split(/\r?\n/).length).toBeLessThanOrEqual(100);
    expect(chat.split(/\r?\n/).length).toBeLessThanOrEqual(900);
    expect(resources).toContain('from "./chat.js"');
    expect(resources).toContain('from "./company.js"');
    expect(resources).toContain('from "./providers.js"');
    expect(resources).toContain('from "./settings-integrations.js"');
    expect(resources).not.toMatch(/function\s+(?:processStoredChat|createProvider|createWebhook|updateCompany)\b/);
    expect(chat).toContain("export async function processStoredChat");
    expect(company).toContain("export async function handleCompanyRoute");
    expect(providers).toContain("export async function handleProviderRoute");
    expect(settingsIntegrations).toContain("export async function handleSettingsIntegrationRoute");
    expect(settingsIntegrations).toContain("settings/mcp-connections");
    expect(chatJobs).toContain('from "../http/handlers/chat.js"');
  });

  test("separates analytics, dashboard compatibility, and synthesis/canvas ownership", async () => {
    const [catalog, analyticsDashboard, synthesisCanvas] = await Promise.all([
      source("src/http/handlers/analytics-catalog.ts"),
      source("src/http/handlers/analytics-dashboard.ts"),
      source("src/http/handlers/synthesis-canvas.ts"),
    ]);
    expect(catalog.split(/\r?\n/).length).toBeLessThanOrEqual(180);
    expect(analyticsDashboard.split(/\r?\n/).length).toBeLessThanOrEqual(450);
    expect(synthesisCanvas.split(/\r?\n/).length).toBeLessThanOrEqual(250);
    expect(catalog).toContain('from "./analytics-dashboard.js"');
    expect(catalog).toContain('from "./synthesis-canvas.js"');
    expect(catalog).not.toMatch(/function\s+(?:analytics|dashboardSummary|synthesis|canvasValidate)\b/);
    expect(analyticsDashboard).toContain("export async function handleAnalyticsDashboardRoute");
    expect(synthesisCanvas).toContain("export async function handleSynthesisCanvasRoute");
    expect(catalog).toContain('route.path === `${base}/semantic-search`');
    expect(catalog).not.toContain("async function semanticSearch");
  });
});

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const source = resolve("fixtures/parity/http/route-wire-capture.json");
const target = resolve("src/http/generated-routes.ts");
const capture = JSON.parse(await readFile(source, "utf8"));
const routes = capture.routes.map(({ method, pattern }) => ({ method, path: pattern }));
if (routes.length !== 168) throw new Error(`expected 168 explicit routes, found ${routes.length}`);
// Keep the captured graph immutable; name every intentional product extension.
routes.push(...[
  "/api/executions/:id/approve", "/api/executions/:id/reject",
  "/api/workflows/:id/approve-generation", "/api/workflows/:id/reject-generation",
  "/api/workflows/:id/commands", "/api/workflows/:id/node-proposals",
  "/api/workflows/:id/readiness",
  "/api/executions/:id/events",
  "/api/chat/models",
  "/api/chat/capabilities",
  "/api/registry/capabilities", "/api/registry/capabilities/discovery", "/api/registry/capabilities/:id/review", "/api/registry/capabilities/:id/disable",
  "/api/settings/mcp-connections", "/api/settings/mcp-connections/:id/connect", "/api/settings/mcp-connections/:id/disconnect", "/api/settings/mcp-connections/:id/test",
  "/api/chat/sessions/:id/operations", "/api/chat/operations/:id", "/api/chat/operations/:id/cancel",
].map((path) => ({ method: /\/(readiness|events|models|operations|capabilities|mcp-connections)$/.test(path) || path === "/api/chat/operations/:id" ? "GET" : "POST", path })));
const content = `// Generated from frozen Go routes plus named product extensions. Do not hand-edit.\n` +
  `export const routeTable = ${JSON.stringify(routes, null, 2)} as const;\n` +
  `export type RouteDefinition = (typeof routeTable)[number];\n`;
await mkdir(dirname(target), { recursive: true });
await writeFile(target, content);
console.log(`generated ${routes.length} routes`);

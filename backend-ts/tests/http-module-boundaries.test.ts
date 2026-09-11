import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const source = (path: string) => readFile(resolve(path), "utf8");

describe("HTTP responsibility boundaries", () => {
  test("keeps the application composition root below the agreed size ceiling", async () => {
    const app = await source("src/http/app.ts");
    expect(app.split(/\r?\n/).length).toBeLessThanOrEqual(1_500);
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
});

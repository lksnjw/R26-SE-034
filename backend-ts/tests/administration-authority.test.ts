import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import { afterEach, expect, test } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { buildApp } from "../src/http/app.js";
import { RegistryService } from "../src/registry/service.js";
import { Repository } from "../src/repository/store.js";
import { Executor } from "../src/runner/executor.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { RegistryValidator } from "../src/validator/registry-validator.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function setup() {
  const config = loadConfig({ APP_ENV: "test", JWT_SECRET: "administration-authority-test-secret", STORAGE_DRIVER: "memory", MCP_MODE: "mock" });
  const repository = new Repository(null);
  await repository.mutate((state) => {
    const createdAt = new Date().toISOString();
    const allPermissions = state.permissions.map((permission) => permission.key);
    state.roles.delegated = { id: "delegated", name: "Delegated administrator", description: "Fixture", permissions: allPermissions, createdAt };
    state.users.delegated = { id: "delegated", name: "Delegated", email: "delegated@example.test", roleId: "delegated", permissionOverrides: [], status: "Active", initials: "D", departmentId: null, lastLoginAt: null, createdAt };
    state.users.platform = { id: "platform", name: "Platform", email: "platform@example.test", roleId: "role_admin", permissionOverrides: [], status: "Active", initials: "P", departmentId: null, lastLoginAt: null, createdAt };
    state.users.system = { id: "system", name: "System", email: "system@example.test", roleId: "role_system_admin", permissionOverrides: [], status: "Active", initials: "S", departmentId: null, lastLoginAt: null, createdAt };
    state.roles.custom = { id: "custom", name: "Custom", description: "Before", permissions: ["workflow:read"], createdAt };
    state.users.holder = { id: "holder", name: "Holder", email: "holder@example.test", roleId: "custom", permissionOverrides: [], status: "Active", initials: "H", departmentId: null, lastLoginAt: null, createdAt };
  });
  const registries = await RegistryService.load(resolve("tests/fixtures/tools.json"), resolve("tests/fixtures/rules.json"));
  const validator = new RegistryValidator(registries, repository);
  const app = await buildApp({ config, repository, registries, validator, executor: new Executor(new ToolRegistry(), validator) });
  apps.push(app);
  const headers = (id: string) => ({ authorization: `Bearer ${jwt.sign({}, config.jwtSecret, { algorithm: "HS256", subject: id, expiresIn: 3600 })}` });
  return { app, repository, headers };
}

test.each([
  ["PUT", "/api/users/platform/role", { roleId: "role_builder" }, "reassigned"],
  ["PUT", "/api/users/platform/status", { status: "suspended" }, "suspended"],
  ["DELETE", "/api/users/platform", undefined, "deleted"],
] as const)("last active Platform Admin cannot be %s through delegated full permissions", async (method, url, payload, action) => {
  const s = await setup();
  const response = await s.app.inject({ method, url, headers: s.headers("delegated"), ...(payload ? { payload } : {}) });
  expect(response.statusCode).toBe(409);
  expect(response.json().message).toContain(`cannot be ${action}`);
  expect((await s.repository.snapshot()).users.platform).toMatchObject({ roleId: "role_admin", status: "Active" });
});

test("a lower-authority administrator cannot mutate a stronger account", async () => {
  const s = await setup();
  for (const [method, url, payload] of [
    ["PATCH", "/api/users/platform", { departmentId: "finance" }],
    ["PUT", "/api/users/platform/status", { status: "suspended" }],
    ["DELETE", "/api/users/platform", undefined],
  ] as const) {
    const response = await s.app.inject({ method, url, headers: s.headers("system"), ...(payload ? { payload } : {}) });
    expect(response.statusCode, `${method} ${url}`).toBe(403);
    expect(response.json().message).toBe("Cannot manage a user with permissions the current user does not hold");
  }
});

test("built-in role identity is stable while custom metadata remains editable", async () => {
  const s = await setup();
  const denied = await s.app.inject({ method: "PATCH", url: "/api/roles/role_builder", headers: s.headers("delegated"), payload: { name: "Changed builder" } });
  expect(denied.statusCode).toBe(403);
  expect(denied.json().message).toBe("Built-in role names cannot be changed");
  const changed = await s.app.inject({ method: "PATCH", url: "/api/roles/custom", headers: s.headers("delegated"), payload: { name: "Finance reader", description: "Reviewed read access", permissions: ["workflow:read", "audit:read"] } });
  expect(changed.statusCode, changed.body).toBe(200);
  expect(changed.json().data).toMatchObject({ name: "Finance reader", description: "Reviewed read access", permissions: ["workflow:read", "audit:read"] });
});

test("assigned-role deletion returns the field consumed by the confirmation UI", async () => {
  const s = await setup();
  const response = await s.app.inject({ method: "DELETE", url: "/api/roles/custom", headers: s.headers("delegated") });
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ message: "Role is still assigned to users", meta: { assignedUsers: 1 } });
});

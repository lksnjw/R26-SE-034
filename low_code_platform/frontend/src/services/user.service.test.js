import { expect, test } from "@jest/globals";
import { normalizeAdministrationUsers, normalizePermissionMatrix } from "./user.service";

test("resolves public backend role IDs into truthful user-facing role names", () => {
  expect(normalizeAdministrationUsers(
    [{ id: "user_1", name: "Local QA", roleId: "role_admin" }],
    [{ id: "role_admin", name: "Platform Admin" }],
  )).toEqual([{ id: "user_1", name: "Local QA", roleId: "role_admin", role: "Platform Admin" }]);
});

test("fails closed when administration users are not an array", () => {
  expect(normalizeAdministrationUsers(null, [])).toEqual([]);
});

test("normalizes the backend permission matrix contract into readable role rows", () => {
  expect(normalizePermissionMatrix({
    roles: [{ id: "role_admin", name: "Platform Admin" }, { id: "role_client", name: "Client" }],
    matrix: { role_admin: { "user:manage": true }, role_client: { "user:manage": false } },
  })).toEqual([
    { role: "Platform Admin", roleId: "role_admin", permissions: { "user:manage": true } },
    { role: "Client", roleId: "role_client", permissions: { "user:manage": false } },
  ]);
});

test.each([null, {}, { roles: [], matrix: null }, { roles: {}, matrix: {} }])("invalid permission matrix fails closed as an empty view", (payload) => {
  expect(normalizePermissionMatrix(payload)).toEqual([]);
});

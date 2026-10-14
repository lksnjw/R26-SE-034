/** @jest-environment jsdom */
import React from "react";
import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
let permissions = [];
jest.unstable_mockModule("../context/AuthContext", () => ({ useAuthContext: () => ({ user: { id: "me" } }) }));
jest.unstable_mockModule("../hooks/usePermissions", () => ({ default: () => ({ hasAny: required => required.some(permission => permissions.includes(permission)) }) }));
for (const path of ["../components/navigation/Sidebar", "../components/navigation/Topbar", "../components/navigation/MobileNav", "../components/shared/ServerUnreachableBanner"])
  jest.unstable_mockModule(path, () => ({ default: () => null }));
const { default: AppLayout } = await import("./AppLayout");
afterEach(cleanup);
test.each([
  [["chat:use", "workflow:read_own", "execution:read_own"], true, true],
  [["execution:read_own"], true, false],
  [["chat:use"], false, true],
  [["execution:approve"], false, false],
])("management-header dashboard and workspace links match permissions %j", (grants, dashboard, workspace) => {
  permissions = grants; render(<MemoryRouter><AppLayout><p>Page</p></AppLayout></MemoryRouter>);
  expect(!!screen.queryByRole("link", { name: "Dashboard", exact: true })).toBe(dashboard);
  expect(!!screen.queryByRole("link", { name: /Back to workspace/ })).toBe(workspace);
  if (dashboard) expect(screen.getByRole("link", { name: "Dashboard", exact: true }).getAttribute("href")).toBe("/dashboard");
});

/** @jest-environment jsdom */
import { expect, test } from "@jest/globals";
import { protectedRouteDefinitions, lazyRouteComponents } from "./router";
import { DEFAULT_ROUTE, NAVIGATION_GROUPS } from "../constants/navigation";
import { isWorkspacePath } from "../layouts/WorkspaceLayout";
import { workspaceKey, workspaceReturnPath, writeWorkspaceValue } from "../utils/workspaceSession";

test("authenticated landing stays chat with a separate personal task dashboard", () => {
  expect(protectedRouteDefinitions.find((route) => route.path === "/").Component).toBe(lazyRouteComponents.ChatPage);
  expect(protectedRouteDefinitions.find((route) => route.path === "/dashboard").Component).toBe(lazyRouteComponents.DashboardPage);
  expect(DEFAULT_ROUTE).toEqual({ main: "chat", sub: "home" });
  expect(NAVIGATION_GROUPS.some((group) => group.id === "dashboard")).toBe(false);
});
test("settings and history keep management layout", () => {
  for (const path of ["/", "/chat", "/chat/session-1"]) expect(isWorkspacePath(path)).toBe(true);
  for (const path of ["/settings", "/chat/history", "/chat/history/", "/workflows"]) expect(isWorkspacePath(path)).toBe(false);
});
test("workspace return location is account scoped and rejects external paths", () => {
  const user = { id: "one" };
  writeWorkspaceValue(workspaceKey(user, "return"), "/chat/s1?mode=edit");
  expect(workspaceReturnPath(user)).toBe("/chat/s1?mode=edit");
  expect(workspaceReturnPath({ id: "two" })).toBe("/");
  writeWorkspaceValue(workspaceKey(user, "return"), "https://example.com");
  expect(workspaceReturnPath(user)).toBe("/");
});

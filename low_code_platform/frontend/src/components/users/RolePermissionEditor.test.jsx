/** @jest-environment jsdom */

import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import RolePermissionEditor from "./RolePermissionEditor";

afterEach(cleanup);

const permissions = [
  { key: "workflow:read", name: "Read workflows", description: "Read workflow records." },
  { key: "audit:read", name: "Read audit", description: "Inspect audit evidence." },
];

test("edits custom role metadata and permissions as one governed update", async () => {
  const onSave = jest.fn().mockResolvedValue({});
  render(<RolePermissionEditor roles={[{ id: "finance", name: "Finance", description: "Old", permissions: ["workflow:read"] }]} permissions={permissions} canManage onSave={onSave} />);

  fireEvent.change(screen.getByRole("textbox", { name: "Role name" }), { target: { value: "Finance reviewer" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Role description" }), { target: { value: "Reviewed finance access" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Read audit" }));
  fireEvent.click(screen.getByRole("button", { name: "Save role" }));

  await waitFor(() => expect(onSave).toHaveBeenCalledWith("finance", {
    name: "Finance reviewer",
    description: "Reviewed finance access",
    permissions: ["workflow:read", "audit:read"],
  }));
});

test("keeps built-in role names immutable in the editor", () => {
  render(<RolePermissionEditor roles={[{ id: "role_builder", name: "Workflow Builder", description: "Builder", permissions: ["workflow:read"] }]} permissions={permissions} canManage />);
  expect(screen.getByRole("textbox", { name: "Role name" }).disabled).toBe(true);
  expect(screen.getByText(/Built-in role names are fixed/)).not.toBeNull();
});

test("shows the authoritative assigned-user count when deletion is refused", async () => {
  const onDelete = jest.fn().mockRejectedValue({ response: { data: { meta: { assignedUsers: 2 } } } });
  render(<RolePermissionEditor roles={[{ id: "finance", name: "Finance", description: "", permissions: [] }]} permissions={permissions} canManage onDelete={onDelete} />);
  fireEvent.click(screen.getByRole("button", { name: "Delete role" }));
  fireEvent.click(screen.getAllByRole("button", { name: "Delete role" }).at(-1));
  expect(await screen.findByText("This role is assigned to 2 users and cannot be deleted.")).not.toBeNull();
});

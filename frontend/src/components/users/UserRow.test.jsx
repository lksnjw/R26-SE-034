/** @jest-environment jsdom */

import { afterEach, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import UserRow from "./UserRow";

afterEach(cleanup);

const user = { id: "person", name: "Example Person", email: "person@example.test", initials: "EP", role: "Client", roleId: "role_client", status: "Active", departmentId: null };

test("requires an explicit confirmation before deleting an account", async () => {
  const onDelete = jest.fn().mockResolvedValue({});
  render(<UserRow user={user} roles={[{ id: "role_client", name: "Client" }]} canManage onDelete={onDelete} />);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(onDelete).not.toHaveBeenCalled();
  expect(screen.getByText(/permanently removes the account/)).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Delete account" }));
  await waitFor(() => expect(onDelete).toHaveBeenCalledWith("person"));
});

test("keeps the current account protected from destructive controls", () => {
  render(<UserRow user={user} roles={[{ id: "role_client", name: "Client" }]} canManage isCurrentUser />);
  expect(screen.getByRole("button", { name: "Delete" }).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Suspend" }).disabled).toBe(true);
  expect(screen.getByText("Current account")).not.toBeNull();
});

test("manager changes use the explicit active directory relationship", () => {
  const onManagerChange = jest.fn();
  render(<UserRow user={user} users={[user, { id: "manager", name: "Manager Person", status: "Active" }, { id: "inactive", name: "Inactive", status: "Suspended" }]} roles={[{ id: "role_client", name: "Client" }]} canManage onManagerChange={onManagerChange} />);
  const field = screen.getByRole("combobox", { name: "Manager for Example Person" });
  expect(Array.from(field.options).map((option) => option.textContent)).toEqual(["No manager", "Manager Person"]);
  fireEvent.change(field, { target: { value: "manager" } });
  expect(onManagerChange).toHaveBeenCalledWith("person", "manager");
});

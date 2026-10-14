import { expect, test } from "vitest";
import { Repository } from "../src/repository/store.js";
import { recipientReference, recipientResolutionIsCurrent, resolveRecipientReference } from "../src/delivery/recipient-resolution.js";

async function directory() {
  const repository = new Repository(null);
  await repository.mutate((state) => {
    const createdAt = new Date(0).toISOString();
    state.roles.finance = { id: "finance", name: "Finance Manager", description: "Fixture", permissions: [], createdAt };
    state.users.requester = { id: "requester", name: "Requesting User", email: "requester@example.test", roleId: "role_client", permissionOverrides: [], status: "Active", initials: "RU", departmentId: null, managerId: "manager", lastLoginAt: null, createdAt };
    state.users.manager = { id: "manager", name: "Maya Perera", email: "maya@example.test", roleId: "finance", permissionOverrides: [], status: "Active", initials: "MP", departmentId: null, managerId: null, lastLoginAt: null, createdAt };
  });
  return repository;
}

test("recipient parser retains only an explicit bounded directory label", () => {
  expect(recipientReference("Email the report to my manager every day", [])).toBe("my manager");
  expect(recipientReference("Please email this to Maya Perera.", [])).toBe("Maya Perera");
  expect(recipientReference("Email this to maya@example.test", ["maya@example.test"])).toBeNull();
  expect(recipientReference("Email this to her", [])).toBeNull();
  expect(recipientReference("Email this to Maya Perera and Alex Silva", [])).toBeNull();
});

test("manager and exact-name resolution use active authoritative directory facts", async () => {
  const repository = await directory();
  await repository.read((state) => {
    expect(resolveRecipientReference(state, "requester", "my manager")).toMatchObject({ status: "RESOLVED", source: "DIRECT_MANAGER", userId: "manager", email: "maya@example.test" });
    expect(resolveRecipientReference(state, "requester", "Maya Perera")).toMatchObject({ status: "RESOLVED", source: "EXACT_USER_NAME", userId: "manager" });
    expect(resolveRecipientReference(state, "requester", "Finance Manager")).toMatchObject({ status: "RESOLVED", source: "EXACT_ROLE_SINGLETON", userId: "manager" });
  });
});

test("ambiguous, inactive and changed identities fail closed", async () => {
  const repository = await directory();
  const original = await repository.read((state) => resolveRecipientReference(state, "requester", "my manager"));
  expect(original.status).toBe("RESOLVED");
  await repository.mutate((state) => {
    state.users.manager!.email = "changed@example.test";
    const createdAt = new Date(0).toISOString();
    state.users.duplicate = { id: "duplicate", name: "Maya Perera", email: "other@example.test", roleId: "role_client", permissionOverrides: [], status: "Active", initials: "MP", departmentId: null, managerId: null, lastLoginAt: null, createdAt };
  });
  await repository.read((state) => {
    expect(recipientResolutionIsCurrent(state, "requester", original)).toBe(false);
    expect(resolveRecipientReference(state, "requester", "Maya Perera")).toMatchObject({ status: "AMBIGUOUS", source: null });
  });
});

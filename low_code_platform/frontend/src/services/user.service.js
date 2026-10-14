import { apiClient } from "../config/axios";
import { unwrap } from "./api";

/*******************************************************************************
 * Function: normalizeUser
 *
 * Normalizes user for the user service module.
 ******************************************************************************/
const normalizeUser = (user, roles = []) => {
  const resolvedRole = roles.find((role) => role.id === user?.roleId);
  return { ...user, role: user?.role?.name || resolvedRole?.name || user?.role || "Unassigned" };
};

export function normalizeAdministrationUsers(users, roles) {
  if (!Array.isArray(users)) return [];
  const safeRoles = Array.isArray(roles) ? roles : [];
  return users.map((user) => normalizeUser(user, safeRoles));
}

export function normalizePermissionMatrix(payload) {
  if (!payload || !Array.isArray(payload.roles) || !payload.matrix || typeof payload.matrix !== "object") return [];
  return payload.roles.map((role) => ({
    role: role.name || role.id,
    roleId: role.id,
    permissions: payload.matrix[role.id] && typeof payload.matrix[role.id] === "object" ? payload.matrix[role.id] : {},
  }));
}

export const userService = {
/*******************************************************************************
 * Function: loadAdministration
 *
 * Loads administration for the user service module.
 ******************************************************************************/
  async loadAdministration() {
    const [users, roles, permissions, matrixResponse, departments] = await Promise.all([
      apiClient.get("/users"),
      apiClient.get("/roles"),
      apiClient.get("/permissions"),
      apiClient.get("/permissions/matrix"),
      apiClient.get("/company/departments"),
    ]);
    const roleRows = unwrap(roles, []);
    return {
      users: normalizeAdministrationUsers(unwrap(users, []), roleRows),
      roles: roleRows,
      permissions: unwrap(permissions, []),
      matrix: normalizePermissionMatrix(unwrap(matrixResponse, null)),
      departments: unwrap(departments, []),
    };
  },
/*******************************************************************************
 * Function: loadAudit
 *
 * Loads audit for the user service module.
 ******************************************************************************/
  async loadAudit(params = { limit: 20 }) {
    const response = await apiClient.get("/audit", { params });
    return {
      logs: unwrap(response, []),
      meta: response?.data?.meta ?? null,
    };
  },
/*******************************************************************************
 * Function: create
 *
 * Creates the application for the user service module.
 ******************************************************************************/
  async create(payload) {
    return normalizeUser(unwrap(await apiClient.post("/users", payload)));
  },
/*******************************************************************************
 * Function: updateRole
 *
 * Updates role for the user service module.
 ******************************************************************************/
  async updateRole(userId, roleId) {
    return normalizeUser(unwrap(await apiClient.put(`/users/${userId}/role`, { roleId })));
  },
/*******************************************************************************
 * Function: updateStatus
 *
 * Updates status for the user service module.
 ******************************************************************************/
  async updateStatus(userId, status) {
    return normalizeUser(unwrap(await apiClient.put(`/users/${userId}/status`, { status })));
  },
/*******************************************************************************
 * Function: updateDepartment
 *
 * Updates department for the user service module.
 ******************************************************************************/
  async updateDepartment(userId, departmentId) {
    return normalizeUser(unwrap(await apiClient.patch(`/users/${userId}`, { departmentId: departmentId || null })));
  },
/*******************************************************************************
 * Function: updateManager
 *
 * Stores the explicit directory reporting line used by safe chat recipient
 * resolution. Clearing the selection removes the relationship.
 ******************************************************************************/
  async updateManager(userId, managerId) {
    return normalizeUser(unwrap(await apiClient.patch(`/users/${userId}`, { managerId: managerId || null })));
  },
/*******************************************************************************
 * Function: deleteUser
 *
 * Permanently removes an account after the caller has confirmed the action.
 ******************************************************************************/
  async deleteUser(userId) {
    return unwrap(await apiClient.delete(`/users/${userId}`));
  },
/*******************************************************************************
 * Function: updateRoleDefinition
 *
 * Updates role definition for the user service module.
 ******************************************************************************/
  async updateRoleDefinition(roleId, payload) {
    return unwrap(await apiClient.put(`/roles/${roleId}`, payload));
  },
/*******************************************************************************
 * Function: createRole
 *
 * Creates role for the user service module.
 ******************************************************************************/
  async createRole(payload) {
    return unwrap(await apiClient.post("/roles", payload));
  },
/*******************************************************************************
 * Function: deleteRole
 *
 * Deletes role for the user service module.
 ******************************************************************************/
  async deleteRole(roleId) {
    return unwrap(await apiClient.delete(`/roles/${roleId}`));
  },
/*******************************************************************************
 * Function: assignable
 *
 * Performs the assignable operation on the application for the user service module.
 ******************************************************************************/
  async assignable() {
    return unwrap(await apiClient.get("/workflows/assignable-users"), []);
  },
};

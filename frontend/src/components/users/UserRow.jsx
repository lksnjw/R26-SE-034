import { useState } from "react";
import UserAvatar from "./UserAvatar";
import UserBadge from "./UserBadge";
import Button from "../shared/ui/Button";
import Modal from "../shared/ui/Modal";
import Select from "../shared/ui/Select";
import { apiErrorMessage } from "../../services/api";

/*******************************************************************************
 * Function: UserRow
 *
 * Performs the User Row operation on row for the UserRow module.
 ******************************************************************************/
function UserRow({ user, roles = [], departments = [], isCurrentUser = false, canManage = false, busy = false, onRoleChange, onStatusChange, onDepartmentChange, onDelete }) {
  const suspended = String(user.status).toLowerCase() === "suspended";
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const closeDelete = () => {
    if (busy) return;
    setDeleteOpen(false);
    setDeleteError("");
  };

  const confirmDelete = async () => {
    setDeleteError("");
    try {
      await onDelete?.(user.id);
      setDeleteOpen(false);
    } catch (error) {
      setDeleteError(apiErrorMessage(error, "Could not delete user."));
    }
  };

  return (
    <div className="grid gap-3 border-b border-gray-100 p-4 last:border-0 dark:border-gray-800 lg:grid-cols-[1.2fr_0.7fr_0.7fr_1.6fr] lg:items-center">
      <div className="flex items-center gap-3">
        <UserAvatar initials={user.initials} />
        <div>
          <p className="font-bold text-gray-950 dark:text-white">{user.name}</p>
          <p className="text-xs text-gray-500">{user.email}</p>
        </div>
      </div>
      <UserBadge>{user.role}</UserBadge>
      <span className="text-sm font-semibold text-gray-600 dark:text-gray-300">{user.status}</span>
      <div className="flex flex-wrap items-center gap-2">
        {canManage ? (
          <>
            <Select
              aria-label={`Role for ${user.name}`}
              className="max-w-48"
              value={user.roleId || ""}
              disabled={busy || isCurrentUser}
              onChange={(event) => onRoleChange?.(user.id, event.target.value)}
            >
              {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
            </Select>
            <Select
              aria-label={`Department for ${user.name}`}
              className="max-w-48"
              value={user.departmentId || ""}
              disabled={busy}
              onChange={(event) => onDepartmentChange?.(user.id, event.target.value)}
            >
              <option value="">No department</option>
              {departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
            </Select>
            <Button
              variant="secondary"
              disabled={busy || isCurrentUser}
              onClick={() => onStatusChange?.(user.id, suspended ? "active" : "suspended")}
            >
              {busy ? "Saving..." : suspended ? "Reactivate" : "Suspend"}
            </Button>
            <Button
              variant="secondary"
              disabled={busy || isCurrentUser}
              onClick={() => setDeleteOpen(true)}
            >
              Delete
            </Button>
          </>
        ) : null}
        {isCurrentUser ? <span className="text-xs font-semibold text-gray-500">Current account</span> : null}
      </div>
      <Modal open={deleteOpen} title={`Delete ${user.name}?`}>
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            This permanently removes the account and revokes its active sessions. Workflow and audit records remain retained.
          </p>
          {deleteError ? <p role="alert" className="text-sm font-semibold text-red-600 dark:text-red-300">{deleteError}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" disabled={busy} onClick={closeDelete}>Cancel</Button>
            <Button disabled={busy} onClick={confirmDelete}>{busy ? "Deleting..." : "Delete account"}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default UserRow;

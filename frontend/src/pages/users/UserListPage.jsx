import Button from "../../components/shared/ui/Button";
import Card from "../../components/shared/ui/Card";
import AuditLogTable from "../../components/users/AuditLogTable";
import PermissionMatrix from "../../components/users/PermissionMatrix";
import UserForm from "../../components/users/UserForm";
import UserTable from "../../components/users/UserTable";

function UserListPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <h1 className="page-heading text-gray-950 dark:text-white">Users & Access</h1>
          <p className="mt-3 text-sm leading-6 text-gray-500 dark:text-gray-400">
            Manage team access, roles, permissions, and immutable workflow audit records.
          </p>
        </div>
        <Button>Invite User</Button>
      </div>
      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <UserTable />
          <PermissionMatrix />
          <AuditLogTable />
        </div>
        <Card>
          <h2 className="section-title mb-5">Invite</h2>
          <UserForm />
        </Card>
      </section>
    </div>
  );
}

export default UserListPage;

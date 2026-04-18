import Select from "../shared/ui/Select";

function RoleSelector() {
  return (
    <Select defaultValue="admin">
      <option value="admin">Platform Admin</option>
      <option value="builder">Workflow Builder</option>
      <option value="auditor">Auditor</option>
    </Select>
  );
}

export default RoleSelector;

import Button from "../shared/ui/Button";
import Input from "../shared/ui/Input";
import Select from "../shared/ui/Select";

function UserForm() {
  return (
    <form className="space-y-3">
      <Input placeholder="Full name" />
      <Input placeholder="Email address" />
      <Select defaultValue="builder">
        <option value="builder">Workflow Builder</option>
        <option value="reviewer">Execution Reviewer</option>
        <option value="auditor">Auditor</option>
      </Select>
      <Button>Save User</Button>
    </form>
  );
}

export default UserForm;

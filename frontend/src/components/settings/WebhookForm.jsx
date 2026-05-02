import Button from "../shared/ui/Button";
import Input from "../shared/ui/Input";

function WebhookForm() {
  return (
    <form className="flex gap-2">
      <Input placeholder="https://example.com/workflow-events" />
      <Button>Save</Button>
    </form>
  );
}

export default WebhookForm;

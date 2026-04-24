import { Icon } from "@iconify/react";
import Button from "../shared/ui/Button";
import { useNotifications } from "../../context/NotificationContext";

function WorkflowActions() {
  const { notify } = useNotifications();

  return (
    <div className="flex flex-wrap gap-3">
      <Button onClick={() => notify("Workflow run queued.")}>
        <Icon icon="mdi:play" className="h-5 w-5" />
        Run
      </Button>
      <Button variant="secondary" onClick={() => notify("Workflow exported as YAML.")}>
        <Icon icon="mdi:file-export-outline" className="h-5 w-5" />
        Export YAML
      </Button>
    </div>
  );
}

export default WorkflowActions;

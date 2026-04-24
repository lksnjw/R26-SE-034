import Card from "../../shared/ui/Card";
import Input from "../../shared/ui/Input";
import Textarea from "../../shared/ui/Textarea";

function NodeConfigPanel() {
  return (
    <Card>
      <h2 className="section-title">Node Config</h2>
      <p className="section-subtitle mt-1">Selected node parameters and guardrails.</p>
      <div className="mt-5 space-y-4">
        <label className="block">
          <span className="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-200">
            Node name
          </span>
          <Input defaultValue="Policy Guardrail" />
        </label>
        <label className="block">
          <span className="mb-2 block text-sm font-semibold text-gray-700 dark:text-gray-200">
            Instruction
          </span>
          <Textarea defaultValue="Validate the classified workflow event against approval and data-access policies before downstream actions execute." />
        </label>
      </div>
    </Card>
  );
}

export default NodeConfigPanel;

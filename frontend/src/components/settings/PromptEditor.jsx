import Textarea from "../shared/ui/Textarea";

function PromptEditor() {
  return (
    <Textarea defaultValue="You are the workflow synthesis agent. Produce strict YAML, cite missing requirements, and attach policy guardrails before execution." />
  );
}

export default PromptEditor;

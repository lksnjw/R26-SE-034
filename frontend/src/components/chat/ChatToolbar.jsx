import Select from "../shared/ui/Select";

function ChatToolbar() {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 p-4 dark:border-gray-800">
      <div>
        <h2 className="text-base font-bold text-gray-950 dark:text-white">Workflow Synthesis</h2>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Natural language to YAML with policy validation.
        </p>
      </div>
      <div className="flex gap-2">
        <Select defaultValue="gpt-5.4">
          <option value="gpt-5.4">GPT-5.4</option>
          <option value="gpt-5.4-mini">GPT-5.4 Mini</option>
        </Select>
        <Select defaultValue="balanced">
          <option value="balanced">Balanced</option>
          <option value="strict">Strict YAML</option>
        </Select>
      </div>
    </div>
  );
}

export default ChatToolbar;

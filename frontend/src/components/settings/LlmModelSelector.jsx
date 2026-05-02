import Select from "../shared/ui/Select";

function LlmModelSelector() {
  return (
    <Select defaultValue="gpt-5.4">
      <option value="gpt-5.4">GPT-5.4</option>
      <option value="gpt-5.4-mini">GPT-5.4 Mini</option>
      <option value="local">Local Ollama Runtime</option>
    </Select>
  );
}

export default LlmModelSelector;

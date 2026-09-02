import type { ProviderRuntime } from "../providers/runtime.js";
import { promptData } from "../prompts/contracts.js";
import { parseWorkflowYAMLStrict } from "../parser/workflow.js";

export type WorkflowModifyResult = {
  yaml: string;
  changeDescription: string;
  ok: boolean;
  errorMessage?: string;
};



/*******************************************************************************
 * Function: modifyWorkflow
 *
 * Requests a workflow modification and validates the returned YAML.
 ******************************************************************************/
export async function modifyWorkflow(
  currentYaml: string,
  instruction: string,
  providerRuntime: ProviderRuntime,
  signal?: AbortSignal,
): Promise<WorkflowModifyResult> {
  if (!providerRuntime.configured) {
    return { yaml: currentYaml, changeDescription: "", ok: false, errorMessage: "No LLM provider is configured." };
  }

  const prompt = promptData({ currentYaml, instruction });

  let rawText: string;
  try {
    const response = await providerRuntime.generate(
      prompt,
      "prompt/workflow-modifier/v2",
      signal,
    );
    rawText = response.text.trim();
  } catch (error) {
    return {
      yaml: currentYaml,
      changeDescription: "",
      ok: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }

  const match = rawText.match(/```yaml\s*([\s\S]*?)```/);
  // The compatible provider strips a complete outer Markdown fence.
  const newYaml = (match?.[1] ?? rawText).trim();
  if (newYaml.startsWith("# UNCHANGED:")) {
    const reason = newYaml.split("\n")[0]?.replace("# UNCHANGED:", "").trim() ?? "Modification not possible";
    return { yaml: currentYaml, changeDescription: "", ok: false, errorMessage: reason };
  }
  try { parseWorkflowYAMLStrict(newYaml); }
  catch { return { yaml: currentYaml, changeDescription: "", ok: false, errorMessage: "The model did not return a valid workflow proposal." }; }
  if (newYaml === currentYaml.trim()) return { yaml: currentYaml, changeDescription: "", ok: false, errorMessage: "The model proposed no changes." };

  const changeDescription = describeChange(currentYaml, newYaml, instruction);
  return { yaml: newYaml, changeDescription, ok: true };
}

/*******************************************************************************
 * Function: describeChange
 *
 * Summarizes the requested modification and the change in YAML line count.
 ******************************************************************************/
function describeChange(before: string, after: string, instruction: string): string {
  const beforeLines = before.split("\n").length;
  const afterLines = after.split("\n").length;
  const delta = afterLines - beforeLines;
  const deltaStr = delta > 0 ? `+${delta} lines` : delta < 0 ? `${delta} lines` : "same length";
  return `Proposed: "${instruction.slice(0, 80)}" (${deltaStr})`;
}

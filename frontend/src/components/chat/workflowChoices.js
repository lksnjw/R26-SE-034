import { workflowArtifacts } from "./workflowPreview";

// Presentation projection only. All original messages/proposals remain intact;
// saved workflow source and revision still come from the authoritative editor.
export function workflowChoices(messages) {
  const choices = [], saved = new Map();
  for (const [index, item] of workflowArtifacts(messages).entries()) {
    const id = item.artifact.workflowId;
    if (typeof id !== "string" || !id.trim()) {
      choices.push({ ...item, key: `message:${item.key}`, aliases: [item.key], lastSeen: index });
      continue;
    }
    const existing = saved.get(id);
    if (existing) {
      existing.artifact = item.artifact;
      existing.lastSeen = index;
      if (!existing.aliases.includes(item.key)) existing.aliases.push(item.key);
    } else {
      const choice = { key: `workflow:${id}`, artifact: item.artifact, aliases: [item.key, `handoff:${id}`], lastSeen: index };
      choices.push(choice); saved.set(id, choice);
    }
  }
  return choices;
}

export function selectedWorkflowChoice(choices, key) {
  return choices.find(item => item.key === key) ?? choices.find(item => item.aliases?.includes(key)) ??
    choices.reduce((latest, item) => !latest || item.lastSeen >= latest.lastSeen ? item : latest, null);
}

import { Icon } from "@iconify/react";
import Card from "../../shared/ui/Card";

const skills = [
  { label: "LLM Classifier", icon: "hugeicons:ai-magic" },
  { label: "ERP Connector", icon: "mdi:connection" },
  { label: "Approval Gate", icon: "mdi:account-check-outline" },
  { label: "Self-Healing Retry", icon: "mdi:shield-refresh-outline" },
];

function SkillsPanel() {
  return (
    <Card>
      <h2 className="section-title">Skills</h2>
      <p className="section-subtitle mt-1">Drag-ready blocks for the workflow builder.</p>
      <div className="mt-5 grid gap-3">
        {skills.map((skill) => (
          <button
            key={skill.label}
            className="flex items-center gap-3 rounded-xl border border-gray-200 bg-backgroundLight p-3 text-left text-sm font-semibold text-gray-700 transition hover:border-primary hover:text-primary dark:border-gray-800 dark:bg-darkBackgroundVery dark:text-gray-200"
          >
            <Icon icon={skill.icon} className="h-5 w-5" />
            {skill.label}
          </button>
        ))}
      </div>
    </Card>
  );
}

export default SkillsPanel;

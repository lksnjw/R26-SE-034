import TemplateCard from "../../components/workflows/TemplateCard";

const templates = [
  {
    title: "ERP Exception Resolver",
    description: "Classify ERP anomalies, apply policy guardrails, and route approvals.",
    steps: 7,
  },
  {
    title: "Customer Support Triage",
    description: "Summarize tickets, detect urgency, draft next actions, and escalate risk.",
    steps: 5,
  },
  {
    title: "Ops Self-Healing Monitor",
    description: "Watch connector health, retry safely, and notify owners with evidence.",
    steps: 6,
  },
];

function WorkflowTemplatePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-heading text-gray-950 dark:text-white">Template Gallery</h1>
        <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
          Start from production-shaped workflow patterns.
        </p>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        {templates.map((template) => (
          <TemplateCard key={template.title} {...template} />
        ))}
      </div>
    </div>
  );
}

export default WorkflowTemplatePage;

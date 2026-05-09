import { Icon } from "@iconify/react";

const modelStages = [
  {
    title: "Dataset Selection",
    detail: "Use only valid instruction-to-workflow data for generation fine-tuning.",
    icon: "mdi:file-table-box-multiple-outline",
  },
  {
    title: "Training Run",
    detail: "Track local model jobs, epochs, loss, and YAML validity during training.",
    icon: "mdi:brain",
  },
  {
    title: "Safety Evaluation",
    detail: "Keep mixed validator data separate for PASS/BLOCK Semantic Gate testing.",
    icon: "mdi:shield-check-outline",
  },
];

const warnings = [
  "Do not fine-tune directly on mixed invalid validator records.",
  "Keep Dataset 1 and Dataset 4 usage separated in experiments.",
  "Log model version, dataset hash, and validation score for every run.",
];

function FinetunePage() {
  return (
    <div className="space-y-6">
      <section className="flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
            Separate Member Section
          </p>
          <h1 className="page-heading mt-3 text-gray-950 dark:text-white">Finetune</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-500 dark:text-gray-400">
            Dedicated workspace for model fine-tuning experiments, dataset selection, and safety
            evaluation tracking. This folder is isolated for the fine-tuning team.
          </p>
        </div>
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-purple-200 bg-purple-50 px-4 py-2 text-sm font-bold text-purple-700 dark:border-purple-900/60 dark:bg-purple-950/30 dark:text-purple-300">
          <Icon icon="mdi:tune-variant" className="h-5 w-5" />
          Fine-tune page created
        </span>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {modelStages.map((stage) => (
          <div key={stage.title} className="surface-panel rounded-2xl p-5">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Icon icon={stage.icon} className="h-6 w-6" />
            </span>
            <h2 className="mt-5 text-lg font-bold text-gray-950 dark:text-white">{stage.title}</h2>
            <p className="mt-2 text-sm leading-6 text-gray-500 dark:text-gray-400">{stage.detail}</p>
          </div>
        ))}
      </section>

      <section className="surface-panel rounded-2xl p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
            <Icon icon="mdi:alert-outline" className="h-5 w-5" />
          </span>
          <div>
            <h2 className="section-title">Research Safety Notes</h2>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {warnings.map((warning) => (
                <div
                  key={warning}
                  className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200"
                >
                  {warning}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

export default FinetunePage;

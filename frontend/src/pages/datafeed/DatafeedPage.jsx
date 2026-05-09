import { Icon } from "@iconify/react";

const feeds = [
  {
    name: "BPI 2019 Purchase-to-Pay",
    status: "Reference ready",
    detail: "Purchase order, goods receipt, invoice receipt, and invoice clearance patterns.",
  },
  {
    name: "BPI 2020 Travel Reimbursement",
    status: "Reference ready",
    detail: "Travel permit, declaration, policy check, approval, and payment patterns.",
  },
  {
    name: "Synthetic ERP Dataset",
    status: "Generated",
    detail: "Instruction-to-workflow JSONL and validator evaluation data outputs.",
  },
];

const dataStages = [
  "Reference ingestion",
  "Process pattern extraction",
  "Synthetic sample generation",
  "Schema validation",
  "CSV and JSONL export",
];

function DatafeedPage() {
  return (
    <div className="space-y-6">
      <section className="flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
            Separate Member Section
          </p>
          <h1 className="page-heading mt-3 text-gray-950 dark:text-white">Datafeed</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-500 dark:text-gray-400">
            Dedicated workspace for BPI reference analysis, generated datasets, validation reports,
            and future data pipeline controls. This folder is separate for the datafeed team.
          </p>
        </div>
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-bold text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-300">
          <Icon icon="mdi:database-sync-outline" className="h-5 w-5" />
          Data page created
        </span>
      </section>

      <section className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <div className="surface-panel rounded-2xl p-5">
          <h2 className="section-title">Data Sources</h2>
          <div className="mt-5 grid gap-3">
            {feeds.map((feed) => (
              <div
                key={feed.name}
                className="rounded-xl border border-gray-200 bg-backgroundLight p-4 dark:border-gray-800 dark:bg-darkBackgroundVery"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-bold text-gray-950 dark:text-white">{feed.name}</p>
                    <p className="mt-2 text-sm leading-6 text-gray-500 dark:text-gray-400">
                      {feed.detail}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-full bg-green-100 px-3 py-1 text-xs font-bold text-green-700 dark:bg-green-950/40 dark:text-green-300">
                    {feed.status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="surface-panel rounded-2xl p-5">
          <h2 className="section-title">Pipeline Stages</h2>
          <div className="mt-6 space-y-4">
            {dataStages.map((stage, index) => (
              <div key={stage} className="flex items-center gap-4">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-black text-white">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1 border-b border-gray-200 pb-4 dark:border-gray-800">
                  <p className="text-sm font-bold text-gray-950 dark:text-white">{stage}</p>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    Ready for backend automation and data quality metrics.
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

export default DatafeedPage;

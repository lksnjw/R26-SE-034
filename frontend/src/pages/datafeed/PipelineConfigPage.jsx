import { Icon } from "@iconify/react";

function PipelineConfigPage() {
  return (
    <div className="space-y-6">
      <section className="flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
            Settings
          </p>
          <h1 className="page-heading mt-3 text-gray-950 dark:text-white">Pipeline Configuration</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-500 dark:text-gray-400">
            Adjust the data transformation rules, synchronization limits, and database connection settings.
          </p>
        </div>
        <button className="rounded-lg bg-primary px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-primary/90">
          Save Changes
        </button>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="surface-panel space-y-6 rounded-2xl p-6">
          <h2 className="section-title flex items-center gap-2 border-b border-gray-100 pb-4 dark:border-gray-800">
            <Icon icon="mdi:table-edit" className="h-5 w-5 text-primary" />
            Data Transformation Rules
          </h2>
          
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-semibold text-gray-800 dark:text-gray-200">
                Schema Enforcement
              </label>
              <select className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary dark:border-gray-700 dark:bg-darkBackground dark:text-white">
                <option value="strict">Strict (Reject invalid records)</option>
                <option value="permissive">Permissive (Log errors, continue)</option>
                <option value="disabled">Disabled</option>
              </select>
            </div>
            
            <div>
              <label className="mb-1.5 block text-sm font-semibold text-gray-800 dark:text-gray-200">
                Data Sanitization
              </label>
              <select className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary dark:border-gray-700 dark:bg-darkBackground dark:text-white">
                <option value="standard">Standard (Trim whitespaces, normalize dates)</option>
                <option value="aggressive">Aggressive (Strip HTML, remove special chars)</option>
                <option value="none">None (Raw extraction)</option>
              </select>
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-semibold text-gray-800 dark:text-gray-200">
                Null Value Handling
              </label>
              <select className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary dark:border-gray-700 dark:bg-darkBackground dark:text-white">
                <option value="drop">Drop Record</option>
                <option value="default">Replace with Default Values</option>
                <option value="ignore">Keep as NULL</option>
              </select>
            </div>
          </div>
        </div>

        <div className="surface-panel space-y-6 rounded-2xl p-6">
          <h2 className="section-title flex items-center gap-2 border-b border-gray-100 pb-4 dark:border-gray-800">
            <Icon icon="mdi:database-cog" className="h-5 w-5 text-primary" />
            Sync & Connection Limits
          </h2>
          
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-semibold text-gray-800 dark:text-gray-200">
                Sync Mode
              </label>
              <select className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary dark:border-gray-700 dark:bg-darkBackground dark:text-white">
                <option value="cdc">Continuous (CDC) - Recommended</option>
                <option value="batch">Batch (Every 5 minutes)</option>
                <option value="manual">Manual Trigger Only</option>
              </select>
            </div>
            
            <div>
              <label className="mb-1.5 block text-sm font-semibold text-gray-800 dark:text-gray-200">
                Batch Ingestion Size
              </label>
              <input type="number" defaultValue={1000} className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-900 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary dark:border-gray-700 dark:bg-darkBackground dark:text-white" />
              <p className="mt-1.5 text-[10px] text-gray-500">Maximum number of records to ingest per batch.</p>
            </div>

            <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-gray-50 p-4 dark:border-gray-700 dark:bg-darkBackground">
              <div>
                <p className="text-sm font-bold text-gray-900 dark:text-white">Enable Auto-Retry</p>
                <p className="mt-0.5 text-xs text-gray-500">Automatically retry upon encountering database timeouts.</p>
              </div>
              <label className="relative inline-flex cursor-pointer items-center">
                <input type="checkbox" className="peer sr-only" defaultChecked />
                <div className="peer h-6 w-11 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:bg-primary peer-checked:after:translate-x-full peer-checked:after:border-white peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary/20 dark:border-gray-600 dark:bg-gray-700"></div>
              </label>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

export default PipelineConfigPage;

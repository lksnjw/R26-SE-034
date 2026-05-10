import { useState } from "react";
import { Icon } from "@iconify/react";

function DatafeedPage() {
  const [syncing, setSyncing] = useState(false);

  const handleManualSync = () => {
    setSyncing(true);
    setTimeout(() => setSyncing(false), 2000);
  };

  return (
    <div className="space-y-6">
      <section className="flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
            Infrastructure & Sync
          </p>
          <h1 className="page-heading mt-3 text-gray-950 dark:text-white">Pipeline Status</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-500 dark:text-gray-400">
            Manage your vector database synchronization and configure the real-time continuous ingestion pipeline from the primary database.
          </p>
        </div>
        <button
          onClick={handleManualSync}
          disabled={syncing}
          className="inline-flex w-fit items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-bold text-blue-700 transition-colors hover:bg-blue-100 disabled:opacity-70 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-300 dark:hover:bg-blue-900/40"
        >
          <Icon icon={syncing ? "mdi:loading" : "mdi:refresh"} className={`h-5 w-5 ${syncing ? "animate-spin" : ""}`} />
          {syncing ? "Syncing..." : "Trigger Manual Sync"}
        </button>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        {/* Vector DB Status */}
        <div className="surface-panel rounded-2xl p-5">
          <div className="flex items-center justify-between">
            <h2 className="section-title flex items-center gap-2">
              <Icon icon="mdi:database-search" className="h-5 w-5 text-primary" />
              Vector Database
            </h2>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
              <div className="h-1.5 w-1.5 rounded-full bg-emerald-500"></div>
              ONLINE
            </span>
          </div>
          
          <div className="mt-6 grid grid-cols-2 gap-4">
            <div className="rounded-xl border border-gray-100 bg-gray-50 p-4 dark:border-gray-800 dark:bg-darkBackgroundVery">
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400">Engine</p>
              <p className="mt-1 font-bold text-gray-900 dark:text-white">Qdrant Vector DB</p>
            </div>
            <div className="rounded-xl border border-gray-100 bg-gray-50 p-4 dark:border-gray-800 dark:bg-darkBackgroundVery">
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400">Dimensions</p>
              <p className="mt-1 font-bold text-gray-900 dark:text-white">1,536</p>
            </div>
            <div className="rounded-xl border border-gray-100 bg-gray-50 p-4 dark:border-gray-800 dark:bg-darkBackgroundVery">
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400">Total Vectors</p>
              <p className="mt-1 font-bold text-gray-900 dark:text-white">142,850</p>
            </div>
            <div className="rounded-xl border border-gray-100 bg-gray-50 p-4 dark:border-gray-800 dark:bg-darkBackgroundVery">
              <p className="text-xs font-semibold text-gray-500 dark:text-gray-400">Storage Used</p>
              <p className="mt-1 font-bold text-gray-900 dark:text-white">1.84 GB</p>
            </div>
          </div>
        </div>

        {/* Real DB Sync */}
        <div className="surface-panel rounded-2xl p-5">
          <div className="flex items-center justify-between">
            <h2 className="section-title flex items-center gap-2">
              <Icon icon="mdi:database-sync" className="h-5 w-5 text-primary" />
              Primary DB Sync
            </h2>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-bold text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
              CONTINUOUS
            </span>
          </div>

          <div className="mt-6 space-y-4">
            <div className="flex items-center justify-between border-b border-gray-100 pb-3 dark:border-gray-800">
              <span className="text-sm text-gray-500 dark:text-gray-400">Source Database</span>
              <div className="flex items-center gap-2">
                <Icon icon="logos:postgresql" className="h-4 w-4" />
                <span className="text-sm font-semibold text-gray-950 dark:text-white">PostgreSQL (Primary)</span>
              </div>
            </div>
            <div className="flex items-center justify-between border-b border-gray-100 pb-3 dark:border-gray-800">
              <span className="text-sm text-gray-500 dark:text-gray-400">Sync Method</span>
              <span className="text-sm font-semibold text-gray-950 dark:text-white">CDC (Change Data Capture)</span>
            </div>
            <div className="flex items-center justify-between border-b border-gray-100 pb-3 dark:border-gray-800">
              <span className="text-sm text-gray-500 dark:text-gray-400">Last Successful Sync</span>
              <span className="text-sm font-semibold text-gray-950 dark:text-white">Just now</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500 dark:text-gray-400">Sync Latency</span>
              <span className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">~120ms</span>
            </div>
          </div>
        </div>
      </section>

      <section className="surface-panel rounded-2xl p-5">
        <h2 className="section-title mb-5">Pipeline Configurations</h2>
        
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-gray-200 bg-backgroundLight p-4 dark:border-gray-800 dark:bg-darkBackgroundVery">
            <div className="flex items-center gap-2 text-sm font-bold text-gray-900 dark:text-white">
              <Icon icon="mdi:cog-sync-outline" className="h-5 w-5 text-primary" />
              Batch Ingestion
            </div>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Automatic retry on rate limits
            </p>
            <div className="mt-3 flex items-center justify-between rounded-lg bg-gray-100 px-3 py-1.5 dark:bg-gray-800">
              <span className="text-[10px] uppercase text-gray-500">Batch Size</span>
              <span className="text-xs font-bold text-gray-900 dark:text-white">100</span>
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-backgroundLight p-4 dark:border-gray-800 dark:bg-darkBackgroundVery">
            <div className="flex items-center gap-2 text-sm font-bold text-gray-900 dark:text-white">
              <Icon icon="mdi:table-cog" className="h-5 w-5 text-primary" />
              Data Mapping
            </div>
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Strict schema enforcement enabled
            </p>
            <div className="mt-3 flex items-center justify-between rounded-lg bg-gray-100 px-3 py-1.5 dark:bg-gray-800">
              <span className="text-[10px] uppercase text-gray-500">Validation Mode</span>
              <span className="text-xs font-bold text-gray-900 dark:text-white">Strict</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

export default DatafeedPage;

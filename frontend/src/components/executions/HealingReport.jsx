import { Icon } from "@iconify/react";
import Card from "../shared/ui/Card";

function HealingReport() {
  return (
    <Card>
      <div className="flex items-start gap-4">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-500/15 dark:text-fuchsia-300">
          <Icon icon="mdi:shield-refresh-outline" className="h-6 w-6" />
        </span>
        <div>
          <h2 className="section-title">Self-Healing Report</h2>
          <p className="mt-2 text-sm leading-6 text-gray-500 dark:text-gray-400">
            ERP token refresh recovered the connector and resumed execution without
            duplicating downstream actions.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {["Recovered in 36s", "No duplicate writes", "Owner notified"].map((item) => (
              <div
                key={item}
                className="rounded-xl bg-backgroundLight px-3 py-2 text-sm font-semibold text-gray-700 dark:bg-darkBackgroundVery dark:text-gray-200"
              >
                {item}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

export default HealingReport;

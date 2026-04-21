import BarChart from "../../components/analytics/BarChart";
import DonutChart from "../../components/analytics/DonutChart";
import F1ScoreGauge from "../../components/analytics/F1ScoreGauge";
import HealingSuccessRate from "../../components/analytics/HealingSuccessRate";
import HeatmapCalendar from "../../components/analytics/HeatmapCalendar";
import LineChart from "../../components/analytics/LineChart";
import MetricCard from "../../components/analytics/MetricCard";
import UsageTrendCard from "../../components/analytics/UsageTrendCard";

function AnalyticsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-heading text-gray-950 dark:text-white">Workflow Analytics</h1>
        <p className="mt-3 text-sm leading-6 text-gray-500 dark:text-gray-400">
          Measure execution reliability, token cost, validation quality, and recovery outcomes.
        </p>
      </div>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Runs Today" value="268" detail="+16% vs yesterday" />
        <MetricCard label="Avg Latency" value="1.8s" detail="p95 remains under target" />
        <UsageTrendCard />
        <HealingSuccessRate />
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <BarChart />
        <DonutChart />
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <LineChart />
        <F1ScoreGauge />
        <HeatmapCalendar />
      </section>
    </div>
  );
}

export default AnalyticsPage;

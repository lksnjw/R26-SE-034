import WelcomeBanner from "../../components/dashboard/WelcomeBanner";
import StatsCard from "../../components/dashboard/StatsCard";
import ActivityFeed from "../../components/dashboard/ActivityFeed";
import QuickActions from "../../components/dashboard/QuickActions";
import SystemHealth from "../../components/dashboard/SystemHealth";
import RecentWorkflows from "../../components/dashboard/RecentWorkflows";
import { dashboardMetrics } from "../../constants/mockData";

function DashboardPage() {
  return (
    <div className="space-y-6">
      <WelcomeBanner />

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {dashboardMetrics.map((metric) => (
          <StatsCard key={metric.label} metric={metric} />
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.45fr_0.8fr]">
        <RecentWorkflows />
        <div className="grid gap-4">
          <QuickActions />
          <SystemHealth />
        </div>
      </section>

      <ActivityFeed />
    </div>
  );
}

export default DashboardPage;

import Card from "../../components/shared/ui/Card";
import ExecutionTimeline from "../../components/executions/ExecutionTimeline";
import LiveLogStream from "../../components/executions/LiveLogStream";
import HealingReport from "../../components/executions/HealingReport";

function ExecutionLogsPage() {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <LiveLogStream />
      <div className="space-y-4">
        <HealingReport />
        <Card>
          <h2 className="section-title mb-4">Step Timeline</h2>
          <ExecutionTimeline />
        </Card>
      </div>
    </div>
  );
}

export default ExecutionLogsPage;

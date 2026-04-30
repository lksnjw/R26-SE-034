import Card from "../../components/shared/ui/Card";
import ExecutionFilters from "../../components/executions/ExecutionFilters";
import ExecutionTable from "../../components/executions/ExecutionTable";
import HealingReport from "../../components/executions/HealingReport";
import { executions } from "../../constants/mockData";

function ExecutionListPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-heading text-gray-950 dark:text-white">Execution History</h1>
        <p className="mt-3 text-sm leading-6 text-gray-500 dark:text-gray-400">
          Track run status, token usage, latency, and recovery evidence across every workflow.
        </p>
      </div>
      <ExecutionFilters />
      <ExecutionTable executions={executions} />
      <Card>
        <h2 className="section-title mb-4">Latest Recovery</h2>
        <HealingReport />
      </Card>
    </div>
  );
}

export default ExecutionListPage;

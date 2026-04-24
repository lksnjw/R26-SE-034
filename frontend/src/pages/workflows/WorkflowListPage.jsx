import { Icon } from "@iconify/react";
import Button from "../../components/shared/ui/Button";
import WorkflowCard from "../../components/workflows/WorkflowCard";
import WorkflowFilters from "../../components/workflows/WorkflowFilters";
import WorkflowTable from "../../components/workflows/WorkflowTable";
import { workflows } from "../../constants/mockData";
import { useRoute } from "../../context/RouteContext";

function WorkflowListPage() {
  const { navigateTo } = useRoute();

  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <h1 className="page-heading text-gray-950 dark:text-white">Workflow Blueprints</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-gray-500 dark:text-gray-400">
            Manage YAML-backed workflow definitions, ownership, triggers, and execution health.
          </p>
        </div>
        <Button onClick={() => navigateTo("workflows", "builder")}>
          <Icon icon="mdi:plus" className="h-5 w-5" />
          New Workflow
        </Button>
      </div>

      <WorkflowFilters />

      <section className="grid gap-4 lg:grid-cols-2 xl:grid-cols-4">
        {workflows.map((workflow) => (
          <WorkflowCard key={workflow.id} workflow={workflow} />
        ))}
      </section>

      <WorkflowTable workflows={workflows} />
    </div>
  );
}

export default WorkflowListPage;

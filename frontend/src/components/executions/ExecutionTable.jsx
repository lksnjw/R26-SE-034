import DataTable from "../shared/tables/DataTable";
import ExecutionStatus from "./ExecutionStatus";

const columns = [
  { key: "id", label: "Run ID" },
  { key: "workflow", label: "Workflow" },
  { key: "status", label: "Status" },
  { key: "duration", label: "Duration" },
  { key: "tokens", label: "Tokens" },
  { key: "cost", label: "Cost" },
];

function ExecutionTable({ executions }) {
  return (
    <DataTable
      columns={columns}
      rows={executions}
      renderCell={(run, column) => {
        if (column.key === "status") {
          return <ExecutionStatus status={run.status} />;
        }
        if (column.key === "id") {
          return <span className="font-bold text-primary">{run.id}</span>;
        }
        return run[column.key];
      }}
    />
  );
}

export default ExecutionTable;

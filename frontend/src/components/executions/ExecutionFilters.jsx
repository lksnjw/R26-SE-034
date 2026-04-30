import Input from "../shared/ui/Input";
import Select from "../shared/ui/Select";

function ExecutionFilters() {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <Input className="md:max-w-md" placeholder="Search run id or workflow..." />
      <div className="flex gap-2">
        <Select defaultValue="24h">
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </Select>
        <Select defaultValue="all">
          <option value="all">All statuses</option>
          <option value="failed">Failed</option>
          <option value="healing">Healing</option>
        </Select>
      </div>
    </div>
  );
}

export default ExecutionFilters;

import { Icon } from "@iconify/react";
import Input from "../shared/ui/Input";
import Select from "../shared/ui/Select";

function WorkflowFilters() {
  return (
    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <label className="relative min-w-0 flex-1 md:max-w-md">
        <Icon
          icon="mdi:magnify"
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
        />
        <Input className="pl-9" placeholder="Search workflows..." />
      </label>
      <div className="flex gap-2">
        <Select defaultValue="all">
          <option value="all">All Status</option>
          <option value="running">Running</option>
          <option value="healing">Healing</option>
          <option value="failed">Failed</option>
        </Select>
        <Select defaultValue="recent">
          <option value="recent">Recent</option>
          <option value="success">Success Rate</option>
          <option value="owner">Owner</option>
        </Select>
      </div>
    </div>
  );
}

export default WorkflowFilters;

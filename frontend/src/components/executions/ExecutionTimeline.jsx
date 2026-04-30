import { logs } from "../../constants/mockData";
import StepLogItem from "./StepLogItem";

function ExecutionTimeline() {
  return (
    <div className="space-y-3">
      {logs.map((log, index) => (
        <StepLogItem key={log} log={log} index={index} />
      ))}
    </div>
  );
}

export default ExecutionTimeline;

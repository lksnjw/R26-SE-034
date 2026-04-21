import Card from "../shared/ui/Card";
import { analyticsSeries } from "../../constants/mockData";

function BarChart() {
  const max = Math.max(...analyticsSeries.map((item) => item.runs));

  return (
    <Card className="lg:col-span-2">
      <h2 className="section-title">Run Volume</h2>
      <p className="section-subtitle mt-1">Workflow executions by day.</p>
      <div className="mt-6 flex h-64 items-end gap-3">
        {analyticsSeries.map((item) => (
          <div key={item.label} className="flex flex-1 flex-col items-center gap-2">
            <div
              className="w-full rounded-t-xl bg-primary"
              style={{ height: `${(item.runs / max) * 100}%` }}
              title={`${item.runs} runs`}
            />
            <span className="text-xs font-semibold text-gray-500">{item.label}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export default BarChart;

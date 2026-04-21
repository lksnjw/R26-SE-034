import Card from "../shared/ui/Card";
import { analyticsSeries } from "../../constants/mockData";

function LineChart() {
  const points = analyticsSeries
    .map((item, index) => `${index * 90 + 20},${180 - item.cost * 2}`)
    .join(" ");

  return (
    <Card>
      <h2 className="section-title">Cost Trend</h2>
      <p className="section-subtitle mt-1">Token spend over the current week.</p>
      <svg viewBox="0 0 500 210" className="mt-5 h-52 w-full overflow-visible">
        <polyline fill="none" stroke="#84006A" strokeWidth="5" strokeLinecap="round" points={points} />
        {analyticsSeries.map((item, index) => (
          <circle key={item.label} cx={index * 90 + 20} cy={180 - item.cost * 2} r="5" fill="#84006A" />
        ))}
      </svg>
    </Card>
  );
}

export default LineChart;

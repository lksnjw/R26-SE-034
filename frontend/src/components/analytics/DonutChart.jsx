import Card from "../shared/ui/Card";

function DonutChart() {
  return (
    <Card>
      <h2 className="section-title">Status Breakdown</h2>
      <div className="mt-6 flex items-center justify-center">
        <div
          className="h-44 w-44 rounded-full"
          style={{
            background:
              "conic-gradient(#16A34A 0 72%, #2563EB 72% 86%, #A855F7 86% 95%, #DC2626 95% 100%)",
          }}
        >
          <div className="m-6 flex h-32 w-32 flex-col items-center justify-center rounded-full bg-white dark:bg-darkBackground">
            <span className="text-2xl font-bold text-gray-950 dark:text-white">98.4%</span>
            <span className="text-xs font-semibold text-gray-500">success</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

export default DonutChart;

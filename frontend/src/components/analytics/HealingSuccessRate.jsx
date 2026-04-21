import Card from "../shared/ui/Card";
import Progress from "../shared/ui/Progress";

function HealingSuccessRate() {
  return (
    <Card>
      <h2 className="section-title">Healing Success</h2>
      <p className="mt-4 text-4xl font-bold text-gray-950 dark:text-white">86%</p>
      <div className="mt-4">
        <Progress value={86} />
      </div>
      <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
        Successful automated recoveries in the last 7 days.
      </p>
    </Card>
  );
}

export default HealingSuccessRate;

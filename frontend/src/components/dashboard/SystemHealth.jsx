import Card from "../shared/ui/Card";
import Progress from "../shared/ui/Progress";

const services = [
  { name: "Synthesis API", value: 96, meta: "p95 1.8s" },
  { name: "Execution Workers", value: 88, meta: "12/14 healthy" },
  { name: "MCP Connectors", value: 74, meta: "1 needs token" },
];

function SystemHealth() {
  return (
    <Card>
      <h2 className="section-title">System Health</h2>
      <p className="section-subtitle mt-1">Runtime readiness across critical services.</p>
      <div className="mt-5 space-y-5">
        {services.map((service) => (
          <div key={service.name}>
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="font-semibold text-gray-800 dark:text-gray-100">
                {service.name}
              </span>
              <span className="text-gray-500 dark:text-gray-400">{service.meta}</span>
            </div>
            <Progress value={service.value} />
          </div>
        ))}
      </div>
    </Card>
  );
}

export default SystemHealth;

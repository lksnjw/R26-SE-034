import Card from "../shared/ui/Card";

function HeatmapCalendar() {
  return (
    <Card>
      <h2 className="section-title">Activity Heatmap</h2>
      <div
        className="mt-5 grid gap-1"
        style={{ gridTemplateColumns: "repeat(14, minmax(0, 1fr))" }}
      >
        {Array.from({ length: 56 }).map((_, index) => (
          <span
            key={index}
            className="aspect-square rounded bg-primary/20"
            style={{ opacity: 0.2 + ((index * 17) % 80) / 100 }}
          />
        ))}
      </div>
    </Card>
  );
}

export default HeatmapCalendar;

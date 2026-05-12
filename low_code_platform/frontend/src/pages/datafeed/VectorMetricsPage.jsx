import { Icon } from "@iconify/react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LineChart, Line } from "recharts";

const storageData = [
  { time: "00:00", size: 1.2 },
  { time: "04:00", size: 1.25 },
  { time: "08:00", size: 1.3 },
  { time: "12:00", size: 1.5 },
  { time: "16:00", size: 1.7 },
  { time: "20:00", size: 1.84 },
];

const latencyData = [
  { time: "16:00", latency: 120 },
  { time: "16:10", latency: 135 },
  { time: "16:20", latency: 110 },
  { time: "16:30", latency: 140 },
  { time: "16:40", latency: 115 },
  { time: "16:50", latency: 120 },
];

function VectorMetricsPage() {
  return (
    <div className="space-y-6">
      <section className="flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-primary">
            Analytics
          </p>
          <h1 className="page-heading mt-3 text-gray-950 dark:text-white">Vector DB Metrics</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-500 dark:text-gray-400">
            Monitor the performance, latency, and storage consumption of your vector database and real-time synchronization pipelines.
          </p>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        {/* Storage Growth Area Chart */}
        <div className="surface-panel rounded-2xl p-5">
          <h2 className="section-title mb-6 flex items-center gap-2">
            <Icon icon="mdi:chart-areaspline" className="h-5 w-5 text-primary" />
            Storage Growth (GB)
          </h2>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={storageData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="colorSize" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" className="dark:stroke-gray-800" />
                <XAxis dataKey="time" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "#6b7280" }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "#6b7280" }} />
                <Tooltip 
                  contentStyle={{ borderRadius: "8px", border: "none", boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)" }}
                  itemStyle={{ color: "#1e40af", fontWeight: "bold" }}
                />
                <Area type="monotone" dataKey="size" stroke="#3b82f6" strokeWidth={3} fillOpacity={1} fill="url(#colorSize)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Sync Latency Line Chart */}
        <div className="surface-panel rounded-2xl p-5">
          <h2 className="section-title mb-6 flex items-center gap-2">
            <Icon icon="mdi:chart-timeline-variant" className="h-5 w-5 text-primary" />
            Sync Latency (ms)
          </h2>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={latencyData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" className="dark:stroke-gray-800" />
                <XAxis dataKey="time" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "#6b7280" }} />
                <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: "#6b7280" }} />
                <Tooltip 
                  contentStyle={{ borderRadius: "8px", border: "none", boxShadow: "0 4px 6px -1px rgb(0 0 0 / 0.1)" }}
                  itemStyle={{ color: "#16a34a", fontWeight: "bold" }}
                />
                <Line type="monotone" dataKey="latency" stroke="#16a34a" strokeWidth={3} dot={{ r: 4, strokeWidth: 2 }} activeDot={{ r: 6 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>
    </div>
  );
}

export default VectorMetricsPage;

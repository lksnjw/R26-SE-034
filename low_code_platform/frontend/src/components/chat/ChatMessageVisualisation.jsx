import { useState } from "react";
import { Icon } from "@iconify/react";
import ReadableValue from "./ReadableValue";

function InlineBarChart({ vis }) {
  if (!vis || !Array.isArray(vis.data) || vis.data.length === 0) return null;
  const max = Math.max(...vis.data.map((item) => item.value), 1);
  return (
    <div className="mt-2 rounded-xl border border-gray-100 bg-white p-3 dark:border-gray-800 dark:bg-darkBackground">
      <p className="mb-2 text-xs font-semibold text-gray-700 dark:text-gray-300">{vis.title}</p>
      <div className="space-y-1.5">
        {vis.data.slice(0, 10).map((item, index) => (
          <div key={index} className="flex items-center gap-2 text-xs">
            <span className="w-20 shrink-0 truncate text-right text-gray-400">{item.label}</span>
            <div className="flex-1 rounded-full bg-gray-100 dark:bg-gray-800" style={{ height: 7 }}>
              <div className="rounded-full bg-primary" style={{ width: `${Math.max(2, (item.value / max) * 100)}%`, height: 7 }} />
            </div>
            <span className="w-10 shrink-0 text-right font-semibold text-gray-700 dark:text-gray-200">{item.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function InlineLineChart({ vis }) {
  if (!vis || !Array.isArray(vis.data) || vis.data.length === 0) return null;
  const width = 320;
  const height = 120;
  const padding = 24;
  const values = vis.data.map((item) => item.value);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const step = vis.data.length > 1 ? (width - padding * 2) / (vis.data.length - 1) : 0;
  const points = vis.data.map((item, index) => ({
    x: padding + index * step,
    y: height - padding - ((item.value - min) / range) * (height - padding * 2),
    label: item.label,
    value: item.value,
  }));
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  return (
    <div className="mt-2 rounded-xl border border-gray-100 bg-white p-3 dark:border-gray-800 dark:bg-darkBackground">
      <p className="mb-2 text-xs font-semibold text-gray-700 dark:text-gray-300">{vis.title}</p>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ maxHeight: 140 }}>
        <path d={path} fill="none" className="stroke-primary" strokeWidth="2" />
        {points.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r="2.5" className="fill-primary" />)}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-gray-400">
        <span className="truncate">{points[0]?.label}</span>
        {points.length > 1 && <span className="truncate">{points[points.length - 1]?.label}</span>}
      </div>
    </div>
  );
}

const PIE_COLORS = ["#7c3aed", "#0ea5e9", "#f59e0b", "#10b981", "#ef4444", "#ec4899", "#6366f1", "#84cc16"];

function InlinePieChart({ vis }) {
  if (!vis || !Array.isArray(vis.data) || vis.data.length === 0) return null;
  const total = vis.data.reduce((sum, item) => sum + Math.max(0, item.value), 0) || 1;
  const segments = vis.data.reduce((accumulator, item, index) => {
    const fraction = Math.max(0, item.value) / total;
    const start = accumulator.length > 0 ? accumulator[accumulator.length - 1].end : 0;
    accumulator.push({ ...item, color: PIE_COLORS[index % PIE_COLORS.length], start, end: start + fraction * 360 });
    return accumulator;
  }, []);
  const gradient = segments.map((segment) => `${segment.color} ${segment.start}deg ${segment.end}deg`).join(", ");
  return (
    <div className="mt-2 rounded-xl border border-gray-100 bg-white p-3 dark:border-gray-800 dark:bg-darkBackground">
      <p className="mb-2 text-xs font-semibold text-gray-700 dark:text-gray-300">{vis.title}</p>
      <div className="flex items-center gap-4">
        <div className="h-24 w-24 shrink-0 rounded-full" style={{ background: `conic-gradient(${gradient})` }} />
        <div className="min-w-0 flex-1 space-y-1">
          {segments.slice(0, 8).map((segment, index) => (
            <div key={index} className="flex items-center gap-1.5 text-[11px]">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: segment.color }} />
              <span className="truncate text-gray-600 dark:text-gray-300">{segment.label}</span>
              <span className="ml-auto shrink-0 font-semibold text-gray-700 dark:text-gray-200">{segment.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function InlineVisTable({ vis }) {
  if (!vis || !Array.isArray(vis.data) || vis.data.length === 0) return null;
  return (
    <div className="mt-2 overflow-x-auto rounded-xl border border-gray-100 dark:border-gray-800">
      <p className="border-b border-gray-100 bg-white px-3 py-2 text-xs font-semibold text-gray-700 dark:border-gray-800 dark:bg-darkBackground dark:text-gray-300">{vis.title}</p>
      <table className="w-full min-w-max border-collapse text-xs">
        <tbody>
          {vis.data.map((item, index) => (
            <tr key={index} className="border-b border-gray-50 last:border-0 dark:border-gray-800/60">
              <td className="px-3 py-1.5 text-gray-600 dark:text-gray-400">{item.label}</td>
              <td className="px-3 py-1.5 text-right font-semibold [font-variant-numeric:tabular-nums] text-gray-800 dark:text-gray-200">{item.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function InlineVisualisation({ vis }) {
  if (!vis) return null;
  if (vis.type === "line") return <InlineLineChart vis={vis} />;
  if (vis.type === "pie") return <InlinePieChart vis={vis} />;
  if (vis.type === "table") return <InlineVisTable vis={vis} />;
  return <InlineBarChart vis={vis} />;
}

export function InlineSources({ sources, boundHit }) {
  const [open, setOpen] = useState(false);
  if (!Array.isArray(sources) || sources.length === 0) return null;
  return (
    <div className="mt-2 rounded-xl border border-blue-100 dark:border-blue-900/40">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <Icon icon="mdi:api" className="h-3.5 w-3.5 shrink-0 text-blue-500" />
        <span className="flex-1 text-xs font-semibold text-blue-700 dark:text-blue-300">
          {sources.length} tool call{sources.length !== 1 ? "s" : ""}
          {boundHit ? " · preparation incomplete" : ""}
        </span>
        <Icon icon={open ? "mdi:chevron-up" : "mdi:chevron-down"} className="h-3.5 w-3.5 text-gray-400" />
      </button>
      {open && (
        <div className="border-t border-blue-100 px-3 pb-2 pt-1.5 dark:border-blue-900/40">
          <div className="space-y-1">
            {sources.map((call, index) => (
              <div key={index} className="space-y-2 border-b border-gray-100 py-2 text-[11px] last:border-0 dark:border-gray-800">
                <Icon icon="mdi:function-variant" className="h-3 w-3 shrink-0 text-blue-400" />
                <code className="font-mono text-blue-700 dark:text-blue-300">{call.name}</code>
                {call.arguments && Object.keys(call.arguments).length > 0 && <ReadableValue value={call.arguments} />}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

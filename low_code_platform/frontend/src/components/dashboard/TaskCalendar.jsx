import { ChevronLeft, ChevronRight } from "lucide-react";
import { calendarCells, calendarLabel } from "../../utils/taskCalendar";

export default function TaskCalendar({ month, today, selected, counts, onMonthChange, onSelect }) {
  return <section aria-label="Task calendar" className="min-w-0">
    <div className="mb-5 flex items-center justify-between gap-2">
      <h2 className="text-base font-semibold">{calendarLabel(`${month}-01`, { month: "long", year: "numeric" })}</h2>
      <div className="flex items-center gap-1">
        <button type="button" aria-label="Previous month" disabled={month === "2000-01"} onClick={() => onMonthChange(-1)} className="rounded-lg p-2 hover:bg-gray-100 focus-visible:outline-primary dark:hover:bg-gray-800 disabled:opacity-40"><ChevronLeft size={18} /></button>
        <button type="button" aria-label="Next month" disabled={month === "2100-12"} onClick={() => onMonthChange(1)} className="rounded-lg p-2 hover:bg-gray-100 focus-visible:outline-primary dark:hover:bg-gray-800 disabled:opacity-40"><ChevronRight size={18} /></button>
      </div>
    </div>
    <div className="grid grid-cols-7 gap-1 text-center">
      {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(day => <span key={day} className="pb-2 text-[11px] font-medium text-gray-500">{day}</span>)}
      {calendarCells(month).map(cell => {
        const count = counts[cell.date], current = cell.date === selected;
        return <button type="button" key={cell.date} disabled={!cell.inMonth} aria-pressed={current}
          aria-current={cell.date === today ? "date" : undefined}
          aria-label={`${calendarLabel(cell.date, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}, ${count?.total ?? 0} tasks, ${count?.important ?? 0} important`}
          onClick={() => onSelect(cell.date)}
          className={`relative flex min-h-[60px] min-w-0 flex-col items-center justify-center gap-1 rounded-xl border transition-colors focus-visible:outline-primary motion-reduce:transition-none ${current ? "border-primary bg-primary text-white" : cell.date === today ? "border-primary/40 text-primary" : "border-transparent"} ${!cell.inMonth ? "text-gray-300 dark:text-gray-700" : !current ? "hover:bg-gray-100 dark:hover:bg-gray-800" : ""}`}>
          <span className="text-sm font-medium">{cell.number}</span>
          {count?.total > 0 ? <span aria-hidden="true" className={`rounded px-1.5 text-[10px] font-semibold ${current ? "bg-white/20" : count.important ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200" : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"}`}>{count.total}</span> : <span aria-hidden="true" className="h-[15px]" />}
        </button>;
      })}
    </div>
    <p className="mt-4 text-xs leading-5 text-gray-500 dark:text-gray-400">Numbers show saved tasks. Amber dates include an item needing attention. Future dates show only the next confirmed run.</p>
  </section>;
}

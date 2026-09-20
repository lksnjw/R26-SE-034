export function calendarDate(value, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const part = type => parts.find(value => value.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function calendarTimezone(preferred) {
  try { if (preferred) { new Intl.DateTimeFormat("en", { timeZone: preferred }); return preferred; } } catch { /* Use the browser timezone, never mislabel a date. */ }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
export function moveCalendarMonth(month, offset) {
  const [year, number] = month.split("-").map(Number), date = new Date(Date.UTC(year, number - 1 + offset, 1));
  return date.toISOString().slice(0, 7);
}
export function calendarCells(month) {
  const [year, number] = month.split("-").map(Number), first = new Date(Date.UTC(year, number - 1, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(Date.UTC(year, number - 1, 1 - offset + index)), key = date.toISOString().slice(0, 10);
    return { date: key, number: date.getUTCDate(), inMonth: key.startsWith(month) };
  });
}
export function calendarLabel(date, options) {
  return new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

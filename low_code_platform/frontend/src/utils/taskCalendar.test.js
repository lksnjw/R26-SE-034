import { expect, test } from "@jest/globals";
import { calendarCells, calendarDate, calendarTimezone, moveCalendarMonth } from "./taskCalendar";

test("calendar dates respect the actual timezone at midnight", () => {
  expect(calendarDate("2026-10-08T20:00:00Z", "Asia/Colombo")).toBe("2026-10-09");
  expect(calendarDate("2026-10-08T20:00:00Z", "UTC")).toBe("2026-10-08");
});
test("a saved timezone is preferred and an invalid one safely falls back", () => {
  expect(calendarTimezone("Asia/Colombo")).toBe("Asia/Colombo"); expect(() => calendarTimezone("bad-zone")).not.toThrow();
});
test.each([["2026-12", 1, "2027-01"], ["2026-01", -1, "2025-12"]])("month navigation %s %+s crosses year boundaries", (month, offset, expected) => {
  expect(moveCalendarMonth(month, offset)).toBe(expected);
});
test("calendar starts Monday, retains leap days and has stable unique date keys", () => {
  const cells = calendarCells("2028-02"); expect(cells).toHaveLength(42); expect(cells[0].date).toBe("2028-01-31");
  expect(cells.filter(cell => cell.inMonth)).toHaveLength(29); expect(cells.some(cell => cell.date === "2028-02-29")).toBe(true);
  expect(new Set(cells.map(cell => cell.date)).size).toBe(42);
});

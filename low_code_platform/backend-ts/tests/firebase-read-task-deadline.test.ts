import { describe, expect, test } from "vitest";
import { firebaseReadTaskDeadlineMs } from "../src/firebase/read-task-deadline.js";

describe("Firebase read task deadline", () => {
  test("preserves the default lease fence", () => {
    expect(firebaseReadTaskDeadlineMs(30_000)).toBe(29_900);
  });

  test("allows an explicitly enlarged lease to support a large catalog", () => {
    expect(firebaseReadTaskDeadlineMs(180_000)).toBe(179_900);
    expect(firebaseReadTaskDeadlineMs(300_000)).toBe(240_000);
  });

  test.each([4_999, 300_001, 30_000.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid lease %s", lease => {
    expect(() => firebaseReadTaskDeadlineMs(lease)).toThrow("Invalid read worker lease");
  });
});

import { describe, expect, test } from "@jest/globals";
import { workflows } from "../../../constants/mockData";

describe("workflow fixtures", () => {
  test("provide sample workflows", () => {
    expect(workflows.length).toBeGreaterThan(0);
  });
});

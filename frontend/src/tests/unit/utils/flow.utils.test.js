import { describe, expect, test } from "@jest/globals";
import { workflowToNodes } from "../../../utils/flow.utils";

describe("workflowToNodes", () => {
  test("maps steps to nodes", () => {
    expect(workflowToNodes({ steps: [{ id: "a" }] })).toHaveLength(1);
  });
});

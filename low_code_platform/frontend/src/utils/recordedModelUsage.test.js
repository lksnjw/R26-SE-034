import { expect, test } from "@jest/globals";
import { recordedModelUsage } from "./recordedModelUsage";
import { normalizeExecution } from "../services/execution.service";

test.each([undefined, null, [], "18", {}, { input: "11", output: 7, total: 18 }, { input: 11, output: 7, total: 19 },
  { input: -1, output: 1, total: 0 }, { input: 0.5, output: 1, total: 1.5 }, { input: NaN, output: 1, total: NaN },
  { input: 0, output: 0, total: Infinity }, { input: Number.MAX_SAFE_INTEGER, output: 1, total: Number.MAX_SAFE_INTEGER + 1 }, Object.create({ input: 0, output: 0, total: 0 })])(
  "invalid or missing usage %j displays Not reported, never a guessed zero", value => {
    expect(recordedModelUsage(value)).toBeNull();
    expect(normalizeExecution({ id: "run", tokens: value })).toMatchObject({ tokens: "Not reported", recordedUsage: null });
  });
test("recorded zero remains zero, valid usage retains only exact numeric counters and list formatting stays compact", () => {
  expect(normalizeExecution({ tokens: { input: 0, output: 0, total: 0 } })).toMatchObject({ tokens: "0", recordedUsage: { input: 0, output: 0, total: 0 } });
  const value = { input: 1100, output: 700, total: 1800, token: "must-not-display" };
  expect(normalizeExecution({ tokens: value })).toMatchObject({ tokens: "1.8K", recordedUsage: { input: 1100, output: 700, total: 1800 } });
  expect(recordedModelUsage({ input: Number.MAX_SAFE_INTEGER, output: 0, total: Number.MAX_SAFE_INTEGER })).not.toBeNull();
});

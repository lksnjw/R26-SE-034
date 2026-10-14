import { describe, expect, test } from "@jest/globals";
import { validateYamlText } from "../../../utils/yaml.utils";

describe("validateYamlText", () => {
  test("requires content", () => {
    expect(validateYamlText("").valid).toBe(false);
  });
});

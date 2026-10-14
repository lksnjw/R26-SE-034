import { expect, test } from "@jest/globals";
import { workflowArtifactStatus } from "./workflowArtifactStatus";
test("a validated unpublished draft is not labeled invalid because can_execute is false", () => {
  expect(workflowArtifactStatus({ workflowId: "one", can_execute: false, validation: { passed: true } })).toMatchObject({ label: "Validation passed", draft: "Saved draft" });
});
test("old executable candidate flag is not current publication/live readiness proof", () => {
  expect(workflowArtifactStatus({ can_execute: true })).toMatchObject({ label: "Validation unknown", draft: "Proposed draft" });
});
test("invalid draft keeps explicit validation issues separate from lifecycle", () => {
  expect(workflowArtifactStatus({ validation_passed: false })).toMatchObject({ label: "Validation needs attention", lifecycle: "Not published by this proposal · runtime readiness must be checked" });
});

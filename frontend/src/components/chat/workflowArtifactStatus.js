// Historical model artifacts are not live execution readiness evidence.
export function workflowArtifactStatus(artifact = {}) {
  const passed = artifact.validation?.passed ?? artifact.validation_passed;
  return {
    passed: typeof passed === "boolean" ? passed : null,
    label: passed === true ? "Validation passed" : passed === false ? "Validation needs attention" : "Validation unknown",
    draft: artifact.workflowId ? "Saved draft" : "Proposed draft",
    lifecycle: "Not published by this proposal · runtime readiness must be checked",
  };
}

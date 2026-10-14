// Presentation/retry validation only. The backend owns review authority.
export const sensitivityOptions = [
  { value: "public", label: "Public", description: "Approved for public disclosure." },
  { value: "internal", label: "Internal", description: "For use inside the organization." },
  { value: "confidential", label: "Confidential", description: "Sensitive business or personal information." },
  { value: "restricted", label: "Restricted", description: "Highly sensitive information with tightly controlled access." },
];
export const reviewDataClasses = operation => operation ? ["internal", "confidential"] : sensitivityOptions.map(option => option.value);
export function supportedReviewPolicy(policy) {
  if (!policy || policy.retryPolicy !== "never") return false;
  if (policy.effectClass === "read") return policy.riskClass === "low" && reviewDataClasses(false).includes(policy.dataClass) && policy.requireIndependentApproval === undefined;
  return ["write", "notification"].includes(policy.effectClass) && ["low", "medium"].includes(policy.riskClass) &&
    reviewDataClasses(true).includes(policy.dataClass) && policy.requireIndependentApproval === true;
}
export function reviewPolicyMatches(expected, actual) {
  return supportedReviewPolicy(actual) && ["effectClass", "riskClass", "dataClass", "retryPolicy", "note", "requireIndependentApproval"].every(key => actual[key] === expected[key]);
}

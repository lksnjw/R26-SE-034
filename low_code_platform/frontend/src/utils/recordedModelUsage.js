export const RECORDED_USAGE_EXPLANATION = "Recorded provider usage only. Unreported or unconfirmed calls may be excluded; this is not a billing total.";

// Treat the API as a data boundary: no string coercion or guessed zero.
export function recordedModelUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !["input", "output", "total"].every(key => Object.hasOwn(value, key))) return null;
  const { input, output, total } = value;
  if (![input, output, total].every(count => Number.isSafeInteger(count) && count >= 0) || !Number.isSafeInteger(input + output) || input + output !== total) return null;
  return { input, output, total };
}

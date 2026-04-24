export function required(value) {
  return value ? null : "This field is required.";
}

export function isUrl(value) {
  try {
    new URL(value);
    return null;
  } catch {
    return "Enter a valid URL.";
  }
}

export function truncate(value, length = 80) {
  if (!value || value.length <= length) return value;
  return `${value.slice(0, length - 1)}...`;
}

export function slugify(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

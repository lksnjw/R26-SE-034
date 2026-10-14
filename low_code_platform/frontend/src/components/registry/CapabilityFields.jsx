const label = value => String(value).replaceAll("_", " ").toLowerCase().replace(/^./, letter => letter.toUpperCase());
function fitsInspector(value, depth = 0, budget = { remaining: 1200 }) {
  if (depth > 16 || --budget.remaining < 0) return false;
  if (value && typeof value === "object") return Object.values(value).every(item => fitsInspector(item, depth + 1, budget));
  return true;
}
export function fullyVisible(value) {
  if (!fitsInspector(value)) return false;
  return !value || typeof value !== "object" || Object.keys(value).length <= 60 && Object.values(value).every(fullyVisible);
}
// Literal labelled fields, not HTML or a raw JSON document. An incomplete
// inspector must not authorize a new review.
export default function Fields({ value, depth = 0 }) {
  if (depth > 16) return <p>Nested detail exceeds the inspector limit.</p>;
  if (value === null || value === undefined) return <span>Not specified</span>;
  if (typeof value !== "object") return <span className="whitespace-pre-wrap break-words">{typeof value === "boolean" ? value ? "Yes" : "No" : String(value)}</span>;
  const entries = Object.entries(value);
  if (!entries.length) return <span>No entries</span>;
  return <dl className="space-y-2">{entries.slice(0, 60).map(([key, item]) => <div key={key} className="border-l border-gray-200 pl-3 dark:border-gray-700">
    <dt className="text-xs font-semibold text-gray-500">{Array.isArray(value) ? `Item ${Number(key) + 1}` : label(key)}</dt>
    <dd className="mt-1 text-sm"><Fields value={item} depth={depth + 1} /></dd>
  </div>)}{entries.length > 60 ? <p>Additional entries exceed the inspector limit.</p> : null}</dl>;
}

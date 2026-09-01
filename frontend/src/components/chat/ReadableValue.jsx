import { useState } from "react";

// Presentation only: never summarise, execute HTML, or infer success from data.
export function parseStructuredText(text) {
  if (typeof text !== "string" || text.length > 200000 || !/^\s*[[{]/.test(text)) return undefined;
  try { const value = JSON.parse(text); return value && typeof value === "object" ? value : undefined; } catch { return undefined; }
}

const label = (key) => key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (char) => char.toUpperCase());
const notice = (text) => <p className="text-xs text-gray-500">{text}</p>;

function present(value, depth, budget, limit) {
  if (--budget.remaining < 0) { budget.limited = true; return notice("Additional values are outside this display preview."); }
  if (value === null) return <span className="text-gray-500">Not set</span>;
  if (value === undefined) return <span className="text-gray-500">Not provided</span>;
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  if (typeof value !== "object") {
    const text = String(value);
    return <><span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{text === "" ? "Empty text" : text.slice(0, 12000)}</span>{text.length > 12000 && notice("Long text shortened for display.")}</>;
  }
  if (depth >= 8) return notice("Nested values are outside this display preview.");
  const entries = Object.entries(value);
  if (!entries.length) return notice(Array.isArray(value) ? "No items" : "No fields");
  if (entries.length > limit) budget.more = true;
  const shown = entries.slice(0, limit);
  if (Array.isArray(value)) {
    const rows = shown.map(([, item]) => item);
    const records = rows.every((row) => row && typeof row === "object" && !Array.isArray(row));
    const columns = records ? [...new Set(rows.flatMap((row) => Object.keys(row)))] : [];
    if (columns.length > 0 && columns.length <= 12) return <div className="max-w-full overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs" aria-label="Returned records">
        <thead><tr>{columns.map((key) => <th key={key} title={key} scope="col" className="border-b border-gray-200 px-3 py-2 font-medium text-gray-500 dark:border-gray-700">{label(key)}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => <tr key={index} className="border-b border-gray-100 last:border-0 dark:border-gray-800">{columns.map((key) => <td key={key} className="min-w-24 px-3 py-2 align-top">{present(row[key], depth + 1, budget, limit)}</td>)}</tr>)}</tbody>
      </table>{entries.length > limit && notice(`Showing ${shown.length} of ${entries.length} records.`)}
    </div>;
    return <div><ol className="space-y-2">{shown.map(([key, item]) => <li key={key} className="border-l border-gray-200 pl-3 dark:border-gray-700"><p className="mb-1 text-[10px] text-gray-500">Item {Number(key) + 1}</p>{present(item, depth + 1, budget, limit)}</li>)}</ol>{entries.length > limit && notice(`Showing ${shown.length} of ${entries.length} items.`)}</div>;
  }
  return <div><dl className="space-y-2">{shown.map(([key, item]) => <div key={key} className="border-b border-gray-100 pb-2 last:border-0 dark:border-gray-800"><dt title={key} className="mb-1 text-[10px] font-medium text-gray-500">{label(key)}</dt><dd className="min-w-0">{present(item, depth + 1, budget, limit)}</dd></div>)}</dl>{entries.length > limit && notice(`Showing ${shown.length} of ${entries.length} fields.`)}</div>;
}

export default function ReadableValue({ value }) {
  const [limit, setLimit] = useState(25);
  const budget = { remaining: 1000, more: false, limited: false };
  const content = present(value, 0, budget, limit);
  return <div className="min-w-0 text-xs leading-5 text-gray-800 dark:text-gray-200">{content}
    {budget.more && !budget.limited && limit < 200 && <button type="button" className="mt-2 text-xs font-medium text-primary" onClick={() => setLimit((count) => Math.min(200, count + 25))}>Show more fields and rows</button>}
    {budget.more && limit === 200 && notice("Display preview is limited to 200 fields or rows per collection.")}
  </div>;
}

// Keep both structured data and textual annotations; unsupported MCP blocks are
// acknowledged instead of silently disappearing or fetching remote resources.
export function ReadableResult({ value }) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("content" in value || "structuredContent" in value)) return <ReadableValue value={parseStructuredText(value) ?? value} />;
  const blocks = Array.isArray(value.content) ? value.content.slice(0, 25) : [];
  return <div className="space-y-3">
    {value.isError === true && <p className="text-xs text-red-600">The tool reported an error.</p>}
    {value.structuredContent !== undefined && <ReadableValue value={value.structuredContent} />}
    {blocks.map((block, index) => <div key={index}>{block?.type === "text" && typeof block.text === "string" ? <ReadableValue value={parseStructuredText(block.text) ?? block.text} /> : notice(`Tool returned ${block?.type || "an unsupported"} content. This preview does not display that content type.`)}</div>)}
    {Array.isArray(value.content) && value.content.length > 25 && notice("Additional tool content is outside this display preview.")}
    {value.structuredContent === undefined && !blocks.length && notice("No displayable tool answer was returned.")}
  </div>;
}

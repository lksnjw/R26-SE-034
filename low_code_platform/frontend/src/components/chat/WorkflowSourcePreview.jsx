import { useMemo, useState } from "react";
import { load, JSON_SCHEMA } from "js-yaml";

export default function WorkflowSourcePreview({ source }) {
  const [format, setFormat] = useState("json"), [open, setOpen] = useState(false);
  const json = useMemo(() => {
    if (!open || format !== "json") return "";
    try { return JSON.stringify(load(source, { schema: JSON_SCHEMA }), null, 2); }
    catch { return "JSON preview is unavailable. The original YAML is preserved in Workflow source."; }
  }, [source, open, format]);
  return <details open={open} className="mt-5 border-t border-gray-200 pt-4 text-xs dark:border-gray-700">
    <summary className="cursor-pointer font-medium" onClick={event => { event.preventDefault(); setOpen(value => !value); }}>JSON preview & workflow source</summary>
    {open && <div className="mt-3"><div className="mb-2 flex gap-2" role="group" aria-label="Source preview format">{[ ["json", "JSON preview"], ["yaml", "Workflow source (YAML)"] ].map(([id, title]) => <button type="button" key={id} aria-pressed={format === id} onClick={() => setFormat(id)} className={`rounded px-2 py-1.5 text-[11px] ${format === id ? "bg-primary/10 text-primary" : "text-gray-500"}`}>{title}</button>)}</div><pre aria-label={format === "json" ? "Workflow JSON" : "Workflow YAML"} className="max-h-80 overflow-auto rounded-md bg-gray-100 p-3 text-[10px] dark:bg-gray-900">{format === "json" ? json : source}</pre></div>}
  </details>;
}

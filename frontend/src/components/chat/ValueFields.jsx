import { useState } from "react";
import ReadableValue from "./ReadableValue";

const control = "min-w-0 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-xs dark:border-gray-700 dark:bg-darkBackground";
const defaults = { text: "", number: 0, boolean: false, object: {}, list: [], unset: null };
const kind = (value) => value === null ? "unset" : Array.isArray(value) ? "list" : typeof value === "string" ? "text" : typeof value === "boolean" ? "boolean" : typeof value;

function Field({ name, value, onChange, depth }) {
  const type = kind(value);
  return <div className="min-w-0 space-y-2">
    <div className="flex flex-wrap items-center gap-2"><span className="break-all text-xs text-gray-500">{name}</span><select aria-label={`${name} value type`} className={`${control} ml-auto`} value={type} onChange={(event) => onChange(defaults[event.target.value])}>{Object.keys(defaults).map((option) => <option key={option} value={option}>{({ text: "Text", number: "Number", boolean: "Yes / No", object: "Fields", list: "List", unset: "Not set" })[option]}</option>)}</select></div>
    {type === "text" && <input aria-label={name} className={`${control} w-full`} value={value} onChange={(event) => onChange(event.target.value)} />}
    {type === "number" && <input aria-label={name} type="number" step="any" className={`${control} w-full`} value={value} onChange={(event) => { if (Number.isFinite(event.target.valueAsNumber)) onChange(event.target.valueAsNumber); }} />}
    {type === "boolean" && <select aria-label={name} className={`${control} w-full`} value={String(value)} onChange={(event) => onChange(event.target.value === "true")}><option value="true">Yes</option><option value="false">No</option></select>}
    {(type === "object" || type === "list") && (depth >= 8 ? <><p className="text-xs text-gray-500">Deeply nested fields are preserved. Use a scoped chat proposal to change them.</p><ReadableValue value={value} /></> : <ValueFields value={value} onChange={onChange} label={name} depth={depth + 1} />)}
  </div>;
}

// Generic typed data entry, not a claim of schema-generated validation. The
// authoritative backend still validates the exact registered tool arguments.
export default function ValueFields({ value, onChange, label = "Parameters", depth = 0 }) {
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const list = Array.isArray(value);
  const entries = Object.entries(value);
  const change = (key, next) => { if (list) onChange(value.map((item, index) => index === Number(key) ? next : item)); else onChange({ ...value, [key]: next }); };
  const remove = (key) => onChange(list ? value.filter((_, index) => index !== Number(key)) : Object.fromEntries(entries.filter(([name]) => name !== key)));
  const add = () => {
    if (list) { onChange([...value, ""]); return; }
    if (!newName.trim() || Object.hasOwn(value, newName)) { setError("Enter a unique field name."); return; }
    onChange({ ...value, [newName]: "" }); setNewName(""); setError("");
  };
  return <div aria-label={label} className="space-y-3 border-l border-gray-200 pl-3 dark:border-gray-700">
    {!entries.length && <p className="text-xs text-gray-500">{list ? "No items" : "No fields yet"}</p>}
    {entries.slice(0, 50).map(([key, item]) => <div key={key} className="space-y-1"><Field name={`${label} · ${list ? `Item ${Number(key) + 1}` : key}`} value={item} onChange={(next) => change(key, next)} depth={depth} /><button type="button" className="text-[10px] text-gray-500 hover:text-red-600" onClick={() => remove(key)}>Remove {list ? `item ${Number(key) + 1}` : key}</button></div>)}
    {entries.length > 50 && <p className="text-xs text-gray-500">Additional fields are preserved, but not editable in this preview. Use a scoped chat proposal.</p>}
    <div className="flex min-w-0 flex-wrap gap-2">{!list && <input aria-label={`${label} new field name`} placeholder="Field name" maxLength={128} className={`${control} w-32 flex-1`} value={newName} onChange={(event) => setNewName(event.target.value)} />}<button type="button" className="text-xs font-medium text-primary" onClick={add}>Add {list ? "item" : "field"}</button></div>
    {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
  </div>;
}

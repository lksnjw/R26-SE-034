import { useId, useState } from "react";

const inputClass = "mt-1 w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary dark:border-gray-700 dark:bg-darkBackground";
const safeName = name => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) && !["__proto__", "constructor", "prototype"].includes(name);

/** Named bindings, not a JSON editor. Server scope/schema checks remain final. */
export default function ModelInputFields({ value, onChange, sources = [], label = "Model input", disabled = false }) {
  const listId = useId(), [error, setError] = useState("");
  const named = value !== null && typeof value === "object" && !Array.isArray(value);
  const entries = named ? Object.entries(value) : [];
  const offered = sources.filter(source => source.binding?.source === "nodeOutput" || !source.binding && !source.expression?.startsWith("{{input."));
  const changeMode = next => {
    if (next === "named") onChange({ source: typeof value === "string" ? value : "" });
    else if (entries.length <= 1) onChange(entries[0]?.[1] ?? "");
    setError("");
  };
  const rename = (index, name) => {
    if (!safeName(name) || entries.some(([key], i) => i !== index && key === name)) {
      setError("Use a unique name starting with a letter; reserved names are not allowed."); return;
    }
    onChange(Object.fromEntries(entries.map(([key, ref], i) => [i === index ? name : key, ref]))); setError("");
  };
  const add = () => {
    let suffix = 1;
    while (Object.hasOwn(value, `source_${suffix}`)) suffix++;
    onChange({ ...value, [`source_${suffix}`]: "" }); setError("");
  };
  const sourceInput = (ref, change, name) => <input aria-label={name} className={inputClass} list={offered.length ? listId : undefined} value={ref} onChange={event => change(event.target.value)}
    placeholder="Choose an acknowledged prior output" maxLength={1000} required disabled={disabled} />;
  return <fieldset className="space-y-3" disabled={disabled}>
    <legend className="text-xs text-gray-500">Acknowledged prior outputs</legend>
    <label className="block text-xs text-gray-500">Input shape<select aria-label={`${label} shape`} className={inputClass} value={named ? "named" : "single"} onChange={event => changeMode(event.target.value)}>
      <option value="single" disabled={named && entries.length > 1}>One source</option><option value="named">Named sources · joint input</option>
    </select></label>
    {!named ? sourceInput(value ?? "", onChange, label) : entries.map(([name, ref], index) => <div key={index} className="grid grid-cols-[minmax(6rem,1fr)_minmax(0,2fr)_auto] items-end gap-2">
      <label className="text-xs text-gray-500">Name<input aria-label={`${label} source name ${index + 1}`} className={inputClass} value={name} onChange={event => rename(index, event.target.value)} maxLength={64} required /></label>
      <label className="min-w-0 text-xs text-gray-500">Prior output{sourceInput(ref, next => onChange({ ...value, [name]: next }), `${label} source ${index + 1}`)}</label>
      <button type="button" aria-label={`Remove ${label.toLowerCase()} source ${index + 1}`} disabled={disabled || entries.length <= 1} className="min-h-9 px-2 text-xs text-gray-500 disabled:opacity-40" onClick={() => { onChange(Object.fromEntries(entries.filter((_, i) => i !== index))); setError(""); }}>Remove</button>
    </div>)}
    {named && <button type="button" disabled={disabled || entries.length >= 8} className="min-h-8 text-xs text-primary disabled:opacity-40" onClick={add}>Add named source</button>}
    <datalist id={listId}>{offered.map(source => <option key={source.expression} value={source.expression}>{source.label}</option>)}</datalist>
    {error && <p role="alert" className="text-xs text-amber-700">{error}</p>}
    <p className="text-[10px] leading-4 text-gray-500">Use declared outputs from earlier nodes in this path. Named sources share one item and character limit. Remove extra sources before switching to one source.</p>
  </fieldset>;
}

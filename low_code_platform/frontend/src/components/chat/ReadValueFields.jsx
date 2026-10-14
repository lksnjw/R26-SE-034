import { useState } from "react";
import ReadableValue from "./ReadableValue";

const control = "w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-xs outline-none focus:border-primary dark:border-gray-700 dark:bg-darkBackground";
const types = { string: "Text", number: "Number", integer: "Whole number", boolean: "Yes / No", null: "Explicit null", object: "Fields", array: "List" };
const initialSchema = type => type === "object" ? { type, properties: {}, required: [], additionalProperties: false } : type === "array" ? { type, items: { type: "string" } } : { type };
const literal = value => ({ kind: "literal", value });
const reference = () => ({ kind: "ref", source: "workflowInput", path: [] });
const kindInitial = kind => kind === "literal" ? literal("") : kind === "ref" ? reference() : kind === "object" ? { kind, fields: {} } : kind === "array" ? { kind, items: [] } : { kind: "template", parts: [] };
const safeKey = key => /^[A-Za-z0-9_-]+$/.test(key) && !["__proto__", "constructor", "prototype"].includes(key);

export function SchemaContractFields({ schema, onChange, label = "Output contract", depth = 0 }) {
  const [name, setName] = useState("");
  if (!schema || depth > 8) return <><p className="text-xs text-gray-500">Nested contract preserved. Use a scoped chat proposal to edit it.</p><ReadableValue value={schema} /></>;
  const fields = Object.entries(schema.properties || {});
  return <div className="space-y-3">
    <label className="block text-xs text-gray-500">{label}<select aria-label={`${label} type`} className={`${control} mt-1`} value={schema.type} onChange={event => onChange(initialSchema(event.target.value))}>{Object.entries(types).map(([type, text]) => <option key={type} value={type}>{text}</option>)}</select></label>
    {schema.type === "array" && <div className="border-l pl-3"><SchemaContractFields schema={schema.items} onChange={items => onChange({ ...schema, items })} label={`${label} item`} depth={depth + 1} /></div>}
    {schema.type === "object" && <div className="space-y-3 border-l pl-3">
      {fields.slice(0, 50).map(([key, child]) => <div key={key} className="space-y-2"><SchemaContractFields schema={child} onChange={next => onChange({ ...schema, properties: { ...schema.properties, [key]: next } })} label={`${label} · ${key}`} depth={depth + 1} />
        <label className="text-xs text-gray-500"><input type="checkbox" aria-label={`${label} · ${key} required`} checked={(schema.required || []).includes(key)} onChange={event => onChange({ ...schema, required: event.target.checked ? [...new Set([...(schema.required || []), key])] : (schema.required || []).filter(item => item !== key) })} /> Required</label>
        <button type="button" className="ml-3 text-xs text-gray-500" onClick={() => onChange({ ...schema, properties: Object.fromEntries(fields.filter(([old]) => old !== key)), required: (schema.required || []).filter(old => old !== key) })}>Remove {key} from contract</button></div>)}
      {fields.length > 50 && <p className="text-xs text-gray-500">Additional contract fields preserved.</p>}
      <input aria-label={`${label} new field`} placeholder="Output field name" className={control} value={name} onChange={event => setName(event.target.value)} />
      <button type="button" className="text-xs text-primary" disabled={!safeKey(name) || Object.hasOwn(schema.properties || {}, name) || fields.length >= 50} onClick={() => { onChange({ ...schema, properties: { ...schema.properties, [name]: { type: "string" } } }); setName(""); }}>Add output field</button>
    </div>}
    {Object.keys(schema).some(key => !["type", "properties", "required", "items", "additionalProperties"].includes(key)) && <p className="text-[10px] text-gray-500">Additional contract constraints are preserved. Changing type replaces that contract; review before saving.</p>}
  </div>;
}

export function ReadBindingFields({ value, onChange, dataSources = [], label = "Output value", depth = 0, referenceOnly = false }) {
  const [name, setName] = useState("");
  if (!value || depth > 8) return <><p className="text-xs text-gray-500">Nested mapping preserved. Use scoped chat to edit it.</p><ReadableValue value={value} /></>;
  const scalarType = value.kind === "literal" ? value.value === null ? "null" : typeof value.value : null;
  const sourceIndex = value.kind === "ref" ? dataSources.findIndex(source => source.binding.source === value.source && source.binding.nodeId === value.nodeId && JSON.stringify(source.binding.path) === JSON.stringify(value.path)) : -1;
  const nested = (child, next, text) => <ReadBindingFields value={child} onChange={next} dataSources={dataSources} label={text} depth={depth + 1} />;
  return <div className="space-y-3">
    <label className="block text-xs text-gray-500">{label}<select aria-label={`${label} binding mode`} className={`${control} mt-1`} value={value.kind} onChange={event => onChange(kindInitial(event.target.value))}>{!referenceOnly && <option value="literal">Enter an explicit value</option>}<option value="ref">Use in-scope data</option>{!referenceOnly && <><option value="object">Build fields</option><option value="array">Build a list</option><option value="template">Join text and references</option></>}</select></label>
    {value.kind === "literal" && <><select aria-label={`${label} literal type`} className={control} value={scalarType} onChange={event => onChange(literal(({ string: "", number: 0, boolean: false, null: null })[event.target.value]))}>{["string", "number", "boolean", "null"].map(type => <option key={type} value={type}>{types[type]}</option>)}</select>
      {scalarType === "string" && <input aria-label={label} className={control} value={value.value} onChange={event => onChange(literal(event.target.value))} />}
      {scalarType === "number" && <input aria-label={label} type="number" step="any" className={control} value={value.value} onChange={event => { if (Number.isFinite(event.target.valueAsNumber)) onChange(literal(event.target.valueAsNumber)); }} />}
      {scalarType === "boolean" && <select aria-label={label} className={control} value={String(value.value)} onChange={event => onChange(literal(event.target.value === "true"))}><option value="false">No</option><option value="true">Yes</option></select>}
      {scalarType === "null" && <p className="text-xs text-gray-500">Explicit null · not a missing value</p>}</>}
    {value.kind === "ref" && <>
      <select aria-label={`${label} data source`} className={control} value={sourceIndex} onChange={event => { if (Number(event.target.value) >= 0) onChange(dataSources[Number(event.target.value)].binding); }}><option value={-1}>Manual reference · validation required</option>{dataSources.map((source, index) => <option key={source.expression || index} value={index}>{source.label} · {source.schema.type}</option>)}</select>
      {sourceIndex < 0 && <><select aria-label={`${label} reference source`} className={control} value={value.source} onChange={event => onChange({ ...reference(), source: event.target.value, ...(event.target.value === "nodeOutput" ? { nodeId: "" } : {}), path: value.path })}><option value="workflowInput">Workflow input</option><option value="nodeOutput">Earlier node or branch value</option></select>
        {value.source === "nodeOutput" && <input aria-label={`${label} source node`} className={control} value={value.nodeId || ""} onChange={event => onChange({ ...value, nodeId: event.target.value })} required pattern="[A-Za-z][A-Za-z0-9_-]{0,63}" />}
        <input aria-label={`${label} field path`} className={control} value={value.path.join(".")} onChange={event => onChange({ ...value, path: event.target.value ? event.target.value.split(".") : [] })} placeholder="Field path · e.g. value or structuredContent.id" pattern="[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*" /></>}
      <p className="text-[10px] text-gray-500">Mapping only, not fetched data. The backend checks scope, type and actual value.</p>
    </>}
    {value.kind === "object" && <div className="space-y-3 border-l pl-3">{Object.entries(value.fields).slice(0, 50).map(([key, child]) => <div key={key}>{nested(child, next => onChange({ ...value, fields: { ...value.fields, [key]: next } }), `${label} · ${key}`)}<button type="button" className="mt-2 text-xs text-gray-500" onClick={() => onChange({ ...value, fields: Object.fromEntries(Object.entries(value.fields).filter(([old]) => old !== key)) })}>Remove mapping {key}</button></div>)}
      <input aria-label={`${label} new field`} className={control} value={name} onChange={event => setName(event.target.value)} placeholder="Mapped field name" /><button type="button" className="text-xs text-primary" disabled={!safeKey(name) || Object.hasOwn(value.fields, name) || Object.keys(value.fields).length >= 50} onClick={() => { onChange({ ...value, fields: { ...value.fields, [name]: literal("") } }); setName(""); }}>Add value field</button></div>}
    {value.kind === "array" && <div className="space-y-3 border-l pl-3">{value.items.slice(0, 50).map((child, index) => <div key={index}>{nested(child, next => onChange({ ...value, items: value.items.map((old, pos) => pos === index ? next : old) }), `${label} · Item ${index + 1}`)}<button type="button" className="mt-2 text-xs text-gray-500" onClick={() => onChange({ ...value, items: value.items.filter((_, pos) => pos !== index) })}>Remove value item {index + 1}</button></div>)}<button type="button" className="text-xs text-primary" disabled={value.items.length >= 50} onClick={() => onChange({ ...value, items: [...value.items, literal("")] })}>Add value item</button></div>}
    {value.kind === "template" && <div className="space-y-3 border-l pl-3">{value.parts.slice(0, 50).map((part, index) => <div key={index}>{typeof part === "string" ? <input aria-label={`${label} text part ${index + 1}`} className={control} value={part} onChange={event => onChange({ ...value, parts: value.parts.map((old, pos) => pos === index ? event.target.value : old) })} /> : <ReadBindingFields value={part} onChange={next => onChange({ ...value, parts: value.parts.map((old, pos) => pos === index ? next : old) })} label={`${label} reference part ${index + 1}`} dataSources={dataSources} depth={depth + 1} referenceOnly />}
      <button type="button" className="mt-2 text-xs text-gray-500" onClick={() => onChange({ ...value, parts: value.parts.filter((_, pos) => pos !== index) })}>Remove text part {index + 1}</button></div>)}{["Text", "Reference"].map(type => <button key={type} type="button" className="mr-3 text-xs text-primary" disabled={value.parts.length >= 50} onClick={() => onChange({ ...value, parts: [...value.parts, type === "Text" ? "" : reference()] })}>Add {type.toLowerCase()} part</button>)}</div>}
    {((value.kind === "object" && Object.keys(value.fields).length > 50) || value.items?.length > 50 || value.parts?.length > 50) && <p className="text-xs text-gray-500">Additional mappings are preserved; use scoped chat to edit them.</p>}
  </div>;
}

export default function ReadValueFields({ value, onChange, dataSources, label = "Return" }) {
  return <div className="space-y-4"><SchemaContractFields schema={value.schema} onChange={schema => onChange({ ...value, schema })} label={`${label} contract`} /><ReadBindingFields value={value.value} onChange={next => onChange({ ...value, value: next })} dataSources={dataSources} label={`${label} value`} /><p className="text-[10px] text-gray-500">An explicit contract and mapping are required. Preview and save a draft; no execution occurs here.</p></div>;
}

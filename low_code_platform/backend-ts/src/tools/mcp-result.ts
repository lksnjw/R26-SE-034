import { withoutSecretFields } from "../redact/secrets.js";
import { validateToolInput } from "./tool-input-schema.js";

export const MCP_RESULT_BYTES = 512_000;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const invalid = () => new Error("ERPBridge read returned an unsupported or malformed result envelope");
const base64 = (v: unknown) => typeof v === "string" && v.length <= MCP_RESULT_BYTES && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v);
function text(value: string): string {
  try { return JSON.stringify(withoutSecretFields(JSON.parse(value))); } catch { return value; }
}
function uri(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096) throw invalid();
  try { const parsed = new URL(value); parsed.username = ""; parsed.password = ""; parsed.search = ""; parsed.hash = ""; return parsed.toString(); } catch { throw invalid(); }
}
function annotations(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!record(value) || (value.audience !== undefined && (!Array.isArray(value.audience) || value.audience.some(x => !["user", "assistant"].includes(String(x))))) ||
      (value.priority !== undefined && (typeof value.priority !== "number" || !Number.isFinite(value.priority) || value.priority < 0 || value.priority > 1)) ||
      (value.lastModified !== undefined && typeof value.lastModified !== "string")) throw invalid();
  return { ...(value.audience !== undefined ? { audience: value.audience } : {}), ...(value.priority !== undefined ? { priority: value.priority } : {}), ...(value.lastModified !== undefined ? { lastModified: value.lastModified } : {}) };
}
function content(value: unknown): Record<string, unknown> {
  if (!record(value)) throw invalid();
  const hints = annotations(value.annotations);
  const extra = hints ? { annotations: hints } : {};
  switch (value.type) {
    case "text":
      if (typeof value.text !== "string") throw invalid();
      return { type: "text", text: text(value.text), ...extra };
    case "image": case "audio":
      if (!base64(value.data) || typeof value.mimeType !== "string" || !/^[\w.+-]+\/[\w.+-]+$/.test(value.mimeType)) throw invalid();
      // Bytes are retained as an authorized receipt, not executed or fetched.
      return { type: value.type, data: value.data, mimeType: value.mimeType, ...extra };
    case "resource_link": {
      if (typeof value.name !== "string" || (value.description !== undefined && typeof value.description !== "string") ||
          (value.mimeType !== undefined && typeof value.mimeType !== "string") ||
          (value.size !== undefined && (!Number.isSafeInteger(value.size) || (value.size as number) < 0))) throw invalid();
      return { type: "resource_link", uri: uri(value.uri), name: value.name,
        ...(typeof value.title === "string" ? { title: value.title } : {}), ...(value.description !== undefined ? { description: value.description } : {}),
        ...(value.mimeType !== undefined ? { mimeType: value.mimeType } : {}), ...(value.size !== undefined ? { size: value.size } : {}), ...extra };
    }
    case "resource": {
      const r = value.resource;
      if (!record(r) || (r.mimeType !== undefined && typeof r.mimeType !== "string") ||
          (!("text" in r) && !("blob" in r)) || ("text" in r && "blob" in r) ||
          ("text" in r ? typeof r.text !== "string" : !base64(r.blob))) throw invalid();
      return { type: "resource", resource: { uri: uri(r.uri), ...(r.mimeType !== undefined ? { mimeType: r.mimeType } : {}),
        ...(typeof r.text === "string" ? { text: text(r.text) } : { blob: r.blob }) }, ...extra };
    }
    default: throw invalid();
  }
}
/** Validate original bytes/schema before redaction. Metadata is an allow-listed
 * projection, not instructions or permission. HTTP 200 is not tool success. */
export function safeMcpResult(value: unknown, outputSchema?: Record<string, unknown>): Record<string, unknown> {
  if (!record(value) || !Array.isArray(value.content) || value.content.length > 128 ||
      (value.isError !== undefined && typeof value.isError !== "boolean") ||
      (value.structuredContent !== undefined && !record(value.structuredContent)) || Buffer.byteLength(JSON.stringify(value)) > MCP_RESULT_BYTES) throw invalid();
  if (!value.isError && outputSchema && (value.structuredContent === undefined || validateToolInput(outputSchema, value.structuredContent).length))
    throw new Error("ERPBridge output does not match its reviewed output schema; remote outcome requires review");
  const blocks = value.content.map(content);
  const meta: Record<string, unknown> = {};
  if (record(value._meta) && record(value._meta["com.erpbridge/error"])) {
    const e = value._meta["com.erpbridge/error"];
    if (typeof e.type === "string" && /^[a-z_]{1,64}$/.test(e.type)) meta["com.erpbridge/error"] = {
      type: e.type, ...(typeof e.retryable === "boolean" ? { retryable: e.retryable } : {}),
      ...(Number.isSafeInteger(e.retryAfterMs) && (e.retryAfterMs as number) >= 0 ? { retryAfterMs: e.retryAfterMs } : {}),
    };
  }
  return { content: blocks, ...(value.structuredContent !== undefined ? { structuredContent: withoutSecretFields(value.structuredContent) } : {}),
    ...(value.isError !== undefined ? { isError: value.isError } : {}), ...(Object.keys(meta).length ? { _meta: meta } : {}) };
}

/** Receipt and model context are separate: never feed binary data or resource
 * fetch instructions into a text provider. Audience remains an untrusted hint. */
export function mcpResultForModel(value: unknown): unknown {
  if (!record(value) || !Array.isArray(value.content)) return value;
  return { ...value, content: value.content.filter(b => !record(b) || !record(b.annotations) || !Array.isArray(b.annotations.audience) || b.annotations.audience.includes("assistant")).map(b => {
    if (!record(b)) return b;
    if (["image", "audio"].includes(String(b.type))) return { type: b.type, mimeType: b.mimeType, notice: "Binary attachment is retained in the authorized receipt; it was not interpreted by this model." };
    if (b.type === "resource" && record(b.resource) && "blob" in b.resource) return { type: "resource", resource: { uri: b.resource.uri, mimeType: b.resource.mimeType }, notice: "Binary resource retained; not fetched or interpreted." };
    return b;
  }) };
}

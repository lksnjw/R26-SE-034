/** Bound expanded values, not only source size: repeated references can
 * multiply a small declaration into an otherwise unbounded object/template. */
export class ReadValueBudget {
  private bytes = 0;
  private nodes = 0;
  add(value: string): void {
    this.bytes += Buffer.byteLength(value);
    if (this.bytes > 1_000_000) throw new Error("Resolved read value exceeds byte limits");
  }
  enter(depth: number): void {
    if (++this.nodes > 32768 || depth > 32) throw new Error("Resolved read value exceeds structural limits");
  }
  scalar(value: unknown): string | number | boolean | null {
    if (value !== null && !["string", "boolean", "number"].includes(typeof value) || typeof value === "number" && !Number.isFinite(value)) throw new Error("Resolved read values must be finite JSON");
    this.add(JSON.stringify(value)); return value as string | number | boolean | null;
  }
  clone(value: unknown, depth: number): unknown {
    this.enter(depth);
    if (value === null || typeof value !== "object") return this.scalar(value);
    this.add("[]");
    if (Array.isArray(value)) return value.map(child => { this.add(","); return this.clone(child, depth + 1); });
    return Object.fromEntries(Object.entries(value).map(([key, child]) => { this.add(`${JSON.stringify(key)}:,`); return [key, this.clone(child, depth + 1)]; }));
  }
}

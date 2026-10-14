import { build } from "esbuild";
import { access, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

// Curated upload directory: never copy .env, credentials, test results, owner
// files or node_modules from the checkout into a deployable Functions source.
const root = process.cwd(), outdir = resolve(root, ".functions"), assets = resolve(outdir, "assets/configs/runtime");
// The artifact is generated output. Recreate the exact directory so a stale
// local secret or file can never be uploaded by a later Firebase deployment.
await rm(outdir, { recursive: true, force: true });
await mkdir(assets, { recursive: true });
const manifest = { profile: "lcwe-functions-artifact/v1", qualification: "READ_CHAT_READBACK_OPERATION_LIFECYCLE_ADAPTER_ONLY", assets: {} };
for (const filename of ["all_tools_master_registry.json", "all_rules_master_registry.json", "registry_context.md"]) {
  const source = resolve(root, "configs/runtime", filename), bytes = await readFile(source);
  if (!filename.endsWith(".md")) JSON.parse(bytes.toString("utf8"));
  await copyFile(source, resolve(assets, filename));
  manifest.assets[`configs/runtime/${filename}`] = createHash("sha256").update(bytes).digest("hex");
}
// Governance remains fail-closed; offline read validation needs this exact
// release-managed policy even when external governance is unavailable.
const policyPath = "policy/governance_fallback.json", policyBytes = await readFile(resolve(root, policyPath));
JSON.parse(policyBytes.toString("utf8"));
await mkdir(resolve(outdir, "assets/policy"), { recursive: true });
await copyFile(resolve(root, policyPath), resolve(outdir, "assets", policyPath));
manifest.assets[policyPath] = createHash("sha256").update(policyBytes).digest("hex");
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
await writeFile(resolve(outdir, "package.json"), JSON.stringify({ ...pkg, main: "index.mjs", engines: { node: "22" }, scripts: {} }, null, 2) + "\n");
await copyFile(resolve(root, "package-lock.json"), resolve(outdir, "package-lock.json"));
await build({ absWorkingDir: root, entryPoints: ["src/entrypoints/firebase.ts"], outfile: resolve(outdir, "index.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22", packages: "external", sourcemap: false, logLevel: "info" });
await writeFile(resolve(outdir, "artifact.json"), JSON.stringify(manifest, null, 2) + "\n");
await access(resolve(outdir, "index.mjs"));
console.log("Built actual Firebase exports with packaged governance/registry assets. Partial read/chat/readback/operation and lifecycle adapters; not full production acceptance.");

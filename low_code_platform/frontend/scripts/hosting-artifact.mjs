import { createHash } from "node:crypto";
import { readdir, readFile, lstat } from "node:fs/promises";
import { join, relative } from "node:path";
import assert from "node:assert/strict";
import { hostingBindings, generateHostingConfig } from "./hosting-config.mjs";

export const digest = value => createHash("sha256").update(value).digest("hex");
export const jsonHash = value => digest(JSON.stringify(value));

export function assertRelease({ manifest, config, base, sourceFingerprint, assets, deployProject }) {
  assert.equal(manifest.profile, "firebase-hosting-release/v1");
  const bindings = hostingBindings({ ...manifest.bindings.publicEnv, LCWE_FIREBASE_PROJECT_ID: manifest.bindings.projectId, LCWE_HOSTING_EMULATOR: manifest.bindings.emulatorOnly ? "1" : "0" });
  assert.deepEqual(bindings, manifest.bindings, "Invalid recorded routing bindings");
  if (deployProject) {
    assert.equal(bindings.emulatorOnly, false, "Emulator-only artifacts cannot be deployed");
    assert.equal(deployProject, bindings.projectId, "Deployment project does not match this build");
  }
  assert.deepEqual(config, generateHostingConfig(base, bindings), "Hosting configuration changed after build");
  assert.equal(jsonHash(config), manifest.configFingerprint);
  assert.equal(sourceFingerprint, manifest.sourceFingerprint, "Sources changed; hosting rebuild required");
  assert.deepEqual(assets, manifest.assets, "Hosting files changed after build");
  return bindings;
}

async function filesIn(root) {
  const found = [];
  async function visit(folder) {
    for (const name of (await readdir(folder)).sort()) {
      const path = join(folder, name), stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error("Symlinks are not allowed in hosting inputs");
      if (stat.isDirectory()) await visit(path);
      else if (stat.isFile()) found.push(path);
      else throw new Error("Unexpected hosting input type");
      if (found.length > 4096) throw new Error("Hosting input count exceeded");
    }
  }
  await visit(root); return found;
}

export async function assetProof(publicDir) {
  const records = []; let total = 0;
  for (const path of await filesIn(publicDir)) {
    const name = relative(publicDir, path).replaceAll("\\", "/");
    if (name.split("/").some(part => part.startsWith(".")) || !/\.(html|js|css|png|jpg|jpeg|svg|webp|ico|woff|woff2|txt)$/.test(name) || /(^|\/)(?:src|node_modules|api|ws)\//.test(name)) throw new Error("Unexpected or private file in hosting output");
    const bytes = await readFile(path); total += bytes.length;
    if (bytes.length > 16 * 1024 * 1024 || total > 50 * 1024 * 1024) throw new Error("Hosting artifact budget exceeded");
    if (/-----BEGIN [^-]*PRIVATE KEY-----|"private_key"\s*:|"type"\s*:\s*"service_account"/.test(bytes.toString("utf8"))) throw new Error("Private credential format found in hosting output");
    records.push({ path: name, bytes: bytes.length, sha256: digest(bytes) });
  }
  if (!records.some(record => record.path === "index.html") || !records.some(record => /^assets\/.+\.js$/.test(record.path))) throw new Error("Hosting build is incomplete");
  return { records, totalBytes: total, fingerprint: jsonHash(records) };
}

export async function sourceProof(frontendDir, repositoryDir) {
  const paths = (await filesIn(join(frontendDir, "src"))).filter(path => !/\.(test|spec)\./.test(path));
  const publicDir = join(frontendDir, "public");
  const publicStat = await lstat(publicDir).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  if (publicStat?.isSymbolicLink() || publicStat && !publicStat.isDirectory()) throw new Error("Unexpected public input directory");
  if (publicStat) paths.push(...await filesIn(publicDir));
  paths.push(join(frontendDir, "package.json"), join(frontendDir, "package-lock.json"), join(frontendDir, "vite.config.js"), join(frontendDir, "index.html"), join(repositoryDir, "firebase.json"));
  paths.push(...(await filesIn(join(frontendDir, "scripts"))).filter(path => path.endsWith(".mjs") && !path.endsWith(".test.mjs")));
  const records = [];
  for (const path of paths.sort()) records.push({ path: relative(repositoryDir, path).replaceAll("\\", "/"), sha256: digest(await readFile(path)) });
  return jsonHash(records);
}

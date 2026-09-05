import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { assetProof, sourceProof, assertRelease } from "./hosting-artifact.mjs";

if (process.argv.includes("--base-template")) throw new Error("The root firebase.json is a local template only. Build and verify a project-bound artifact with npm run build:hosting before any authorized release.");
const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), ".."), repositoryDir = resolve(frontendDir, ".."), artifactDir = resolve(frontendDir, ".hosting");
const manifest = JSON.parse(await readFile(resolve(artifactDir, "release-manifest.json"), "utf8"));
const base = JSON.parse(await readFile(resolve(repositoryDir, "firebase.json"), "utf8"));
const config = JSON.parse(await readFile(resolve(artifactDir, "firebase.json"), "utf8"));
const bindings = assertRelease({ manifest, base, config, sourceFingerprint: await sourceProof(frontendDir, repositoryDir), assets: await assetProof(resolve(artifactDir, "public")), deployProject: process.env.GCLOUD_PROJECT });
console.log(`Verified project-bound Hosting artifact (${bindings.emulatorOnly ? "emulator only" : "not yet cloud-qualified"}); no deployment performed.`);

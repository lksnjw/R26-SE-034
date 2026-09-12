import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [dockerfile, dockerignore] = await Promise.all([
  readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
  readFile(new URL("../.dockerignore", import.meta.url), "utf8"),
]);

const runtime = dockerfile.slice(dockerfile.indexOf("FROM node:22-alpine AS runtime"));
assert.notEqual(runtime, dockerfile, "A named runtime stage is required");
assert.match(dockerfile, /npm ci --ignore-scripts/);
assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
assert.doesNotMatch(dockerfile, /COPY\s+\.\s+\./, "The complete build context must not be copied");
assert.match(runtime, /ENV NODE_ENV=production/);
assert.match(runtime, /PORT=8080/);
assert.match(runtime, /COPY --from=build --chown=node:node \/app\/dist\/production\/server\.mjs \.\/dist\/production\/server\.mjs/);
assert.doesNotMatch(runtime, /COPY[^\n]+(?:src|scripts|tests)/, "Runtime image must not include sources or tests");
assert.match(runtime, /USER node\s/);
assert.match(runtime, /HEALTHCHECK[^\n]*[\s\S]*?\/healthz/);
assert.match(runtime, /STOPSIGNAL SIGTERM/);

const ignored = new Set(
  dockerignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#")),
);
for (const required of [
  ".env",
  ".env.*",
  "node_modules",
  "dist",
  "coverage",
  "tests",
  "*.log",
  "*.pem",
  "*.key",
  "service-account.json",
  "*-service-account.json",
]) {
  assert.ok(ignored.has(required), `Docker context must ignore ${required}`);
}

console.log("Backend container artifact passed static release-safety checks.");

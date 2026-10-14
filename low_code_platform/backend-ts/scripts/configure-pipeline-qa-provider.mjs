// User-authorized synthetic QA only. Read the credential from stdin, never argv,
// source, logs or the evidence file. The local acceptance repository is memory-only.
console.log("Waiting for provider credential on stdin (input is not echoed).");
if (process.stdin.isTTY) process.stdin.setRawMode(true);
let apiKey = await new Promise((resolve, reject) => {
  let value = "";
  const receive = chunk => {
    value += chunk.toString("utf8");
    if (!/[\r\n]/.test(value)) return;
    process.stdin.off("data", receive);
    process.stdin.pause();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    resolve(value.split(/[\r\n]/)[0]);
  };
  process.stdin.on("data", receive);
  process.stdin.once("end", () => reject(new Error("Credential input closed; run in a terminal session")));
  process.stdin.resume();
});
apiKey = apiKey.trim();
if (!apiKey) throw new Error("A provider credential is required");
const base = "http://127.0.0.1:18082/api";
const auth = await fetch(`${base}/auth/login`, {method: "POST", headers: {"Content-Type": "application/json"},
  body: JSON.stringify({email: "pipeline.qa@example.test", password: "Pipeline-QA-2026!"})});
if (!auth.ok) throw new Error(`Local QA login failed: HTTP ${auth.status}`);
const token = (await auth.json()).data.accessToken;
async function request(path, body, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(`${base}${path}`, {method, headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(150000)});
  const value = await response.json();
  if (!response.ok) throw new Error(`Local QA ${path} failed: HTTP ${response.status}`);
  return value.data;
}
const keyCheck = await fetch("https://openrouter.ai/api/v1/auth/key", {headers: {Authorization: `Bearer ${apiKey}`}, signal: AbortSignal.timeout(30000)});
console.log(`OpenRouter credential check: HTTP ${keyCheck.status}`);
if (!keyCheck.ok) process.exit(1);
const catalogResponse = await fetch("https://openrouter.ai/api/v1/models", {signal: AbortSignal.timeout(30000)});
if (!catalogResponse.ok) throw new Error(`Provider model catalog failed: HTTP ${catalogResponse.status}`);
const available = new Set((await catalogResponse.json()).data.map(item => item.id));
const candidates = [process.env.GENERATION_MODEL_PRIMARY, process.env.GENERATION_MODEL_FALLBACK,
  "deepseek/deepseek-chat-v3-0324", "openai/gpt-4.1-mini"].filter(Boolean);
const model = candidates.find(item => available.has(item));
if (!model) throw new Error("No reviewed pinned QA model is available in the provider catalog");
const fallbackModel = candidates.find(item => item !== model && available.has(item)) ?? "";
const providers = await request("/providers");
const existing = providers.find(item => item.name === "OpenRouter synthetic QA");
const body = {name: "OpenRouter synthetic QA", type: "openai_compatible", baseUrl: "https://openrouter.ai/api/v1", model,
  fallbackModel, apiKey, temperature: 0, egressPolicy: {approvedOrigin: "https://openrouter.ai", runtimeAnalysisDataClasses: [],
    runtimeAgentDataClasses: [], interactiveDataClasses: ["public", "internal", "confidential", "restricted"], confirmed: true}};
const provider = await request(existing ? `/providers/${existing.id}` : "/providers", body, existing ? "PUT" : "POST");
apiKey = "";
body.apiKey = "";
const test = await request(`/providers/${provider.id}/test`, {});
// Only fixed status/model metadata is emitted; never print provider errors/bodies.
console.log(JSON.stringify({providerId: provider.id, model, fallbackModel, connectionTest: test.ok === true}));
if (!test.ok) process.exit(1);
await request(`/providers/${provider.id}/activate`, {});
console.log("Local QA provider activated. Production configuration was not modified.");

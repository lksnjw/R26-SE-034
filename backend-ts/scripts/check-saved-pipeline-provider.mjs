// Read only the configured workspace provider; never dump repository data or keys.
import {loadConfig} from "../src/config/config.ts";
import {openApplicationRepository} from "../src/storage/open-repository.ts";
const config = loadConfig(process.env, process.cwd());
const repository = await openApplicationRepository(config, 20000);
try {
  const records = await repository.read(state => Object.values(state.providers).filter(record => record.active === true));
  for (const record of records) {
    const response = await fetch(`${record.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", headers: {Authorization: `Bearer ${record.apiKey}`, "Content-Type": "application/json"},
      body: JSON.stringify({model: record.model, messages: [{role: "user", content: "Reply with OK."}], max_tokens: 32}),
      signal: AbortSignal.timeout(30000), redirect: "error"});
    const result = await response.json();
    console.log(JSON.stringify({savedProvider: record.name, model: record.model, status: response.status, code: result.error?.code}));
  }
  if (!records.length) console.log("No active saved workspace provider is configured.");
} finally { await repository.close(); }

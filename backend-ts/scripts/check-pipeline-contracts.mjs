import { readFile } from "node:fs/promises";
import { createBridgeProtocolAdapter } from "../src/tools/erpbridge-protocol-adapter.ts";
import { validateToolSchemaProfile } from "../src/tools/tool-input-schema.ts";
import { discoveredContract } from "../src/registry/discovered-contract.ts";
const session = JSON.parse(await readFile("../tmp/pipeline-local/session.json", "utf8"));
const bridge = createBridgeProtocolAdapter({baseURL: "http://127.0.0.1:18080", token: session.mcpToken, timeoutMs: 15000});
try {
  await bridge.connect();
  for (const remote of await bridge.listTools()) {
    const input = validateToolSchemaProfile(remote.inputSchema), output = validateToolSchemaProfile(remote.outputSchema);
    let admission = "supported"; try { discoveredContract(remote, "erpbridge-default"); } catch (error) { admission = error.message; }
    console.log(JSON.stringify({name: remote.name, input, output, admission}));
  }
} finally { await bridge.close(); }

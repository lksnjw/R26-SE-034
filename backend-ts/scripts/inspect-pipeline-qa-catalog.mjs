import {readFile} from "node:fs/promises";
const session = JSON.parse(await readFile("../tmp/pipeline-local/session.json", "utf8"));
const response = await fetch("http://127.0.0.1:8000/v1/search", {headers: {"X-API-Key": session.ERP_API_KEY}, signal: AbortSignal.timeout(15000)});
console.log(`Pipeline catalog HTTP ${response.status}`);
console.log(JSON.stringify(await response.json(), null, 2));

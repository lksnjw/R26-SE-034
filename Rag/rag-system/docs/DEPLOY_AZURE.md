# Deploying to Azure Container Apps

**Target:** Azure Container Apps — serverless containers, scale-to-zero, HTTPS
ingress included, and a free monthly grant (180k vCPU-seconds / 360k GiB-seconds)
that a demo workload stays inside. App Service also works, but Linux containers
there need a B1 tier or above, which is billed hourly whether or not anyone
calls it.

## Why this is deployable at all

The image contains the API and nothing else — 567MB, no model weights, no GPU,
no sidecar:

| Component | Where it runs |
|---|---|
| FastAPI policy gate | the container |
| LLM + embeddings | Google Gemini, over HTTPS |
| Vector store | Qdrant Cloud |

With a local Ollama this would need several GB of RAM and a model pull on every
cold start. Moving the models to an API is what made a small serverless
container viable.

## Before you deploy

**1. Seed the corpus once, from anywhere.** The image deliberately does not seed
on boot: seeding writes to a shared Qdrant collection, and a platform that scales
the container out would have every replica rewriting the corpus.

```bash
python -m scripts.seed_qdrant_policies --recreate
```

**2. Set `API_KEYS`.** Not optional on a public address. `actor.role` is trusted
completely and cannot be verified by this service — without a key, anyone can
post `role=finance_manager` and be told a payment is permitted, so every
threshold, role and segregation rule is being decided on a string the sender
chose. Generate one:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

**3. Decide `ENABLE_DEMO`.** The demo page is served with an API key embedded so
the browser can call the API — which hands a working credential to anyone who
loads the page. `ENABLE_DEMO=False` in any deployment where that matters.

## Deploy

```bash
az login
az group create --name rg-policy-gate --location centralindia

# Builds the image in Azure (no local Docker push needed) and creates the app.
az containerapp up \
  --name policy-gate \
  --resource-group rg-policy-gate \
  --location centralindia \
  --source . \
  --ingress external \
  --target-port 8000
```

Location note: some subscriptions (e.g. Azure for Students tenants) carry a
subscription-level policy restricting which regions can be deployed to. Check
before assuming `eastus` works:

```bash
az policy assignment list --query "[].displayName" -o table
az policy assignment show --name sys.regionrestriction \
  --query "parameters.listOfAllowedLocations.value" -o tsv
```

If `eastus` isn't in that list, a deploy targeting it fails client-side before
creating anything — no resource, nothing in the activity log, easy to mistake
for a general subscription problem. Use one of the allowed regions instead.

### If `containerapp up` fails with `TasksOperationsNotAllowed`

`--source .` builds the image remotely via **ACR Tasks**. Azure for Students
(and other sponsored/education subscriptions) have ACR Tasks disabled outright:

```
ERROR: (TasksOperationsNotAllowed) ACR Tasks requests for the registry
<name> and <subscription-id> are not permitted. Please file an Azure
support request at http://aka.ms/azuresupport for assistance.
```

This is a subscription-level block, not a missing provider registration — it
does not go away on retry, and the support-ticket path is slow. The `up`
command has already created the resource group, the Container Apps
environment, and the (empty) registry by the time it fails, so nothing here
is wasted; the fix is to build and push the image yourself instead of asking
ACR to do it, then point Container Apps at the result.

**Requires:** Docker Desktop (or another local Docker daemon) running.

```bash
# The registry `up` already created — reuse it, don't recreate.
ACR=$(az acr list --resource-group rg-policy-gate --query "[0].name" -o tsv)

az acr login --name $ACR

docker build -t $ACR.azurecr.io/policy-gate:latest .
docker push $ACR.azurecr.io/policy-gate:latest

# admin creds — fine for a student/demo deployment; use a managed identity
# instead if this becomes a real production registry.
CREDS=$(az acr credential show --name $ACR --query "{u:username,p:passwords[0].value}" -o json)
ACR_USER=$(echo $CREDS | python -c "import sys,json; print(json.load(sys.stdin)['u'])")
ACR_PASS=$(echo $CREDS | python -c "import sys,json; print(json.load(sys.stdin)['p'])")

az containerapp create \
  --name policy-gate \
  --resource-group rg-policy-gate \
  --environment policy-gate-env \
  --image $ACR.azurecr.io/policy-gate:latest \
  --target-port 8000 \
  --ingress external \
  --registry-server $ACR.azurecr.io \
  --registry-username $ACR_USER \
  --registry-password $ACR_PASS \
  --min-replicas 0 \
  --max-replicas 2
```

`policy-gate-env` is the environment name `up` already created — check it with
`az containerapp env list --resource-group rg-policy-gate -o table` if unsure.
Once this succeeds, continue with **Then set configuration** below exactly as
if `up` had worked — secrets, env vars, and verification are all identical
from here on; only how the image got built and how the app got created differ.

Then set configuration. Secrets go in as secrets, never as plain env vars and
never baked into the image:

```bash
az containerapp secret set \
  --name policy-gate --resource-group rg-policy-gate \
  --secrets api-key=<gemini key> qdrant-key=<qdrant key> gate-key=<generated above>

az containerapp update \
  --name policy-gate --resource-group rg-policy-gate \
  --set-env-vars \
    MODEL_PROVIDER=api \
    API_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/ \
    LLM_MODEL=gemini-3.5-flash-lite \
    JUDGE_MODEL=gemini-3.5-flash-lite \
    API_EMBED_MODEL=gemini-embedding-001 \
    EMBED_DIMENSION=3072 \
    API_TOKEN_FACTOR=8 \
    API_MAX_RETRIES=8 \
    QDRANT_URL=<your qdrant url> \
    POLICY_COLLECTION=policy_docs \
    POLICY_FAIL_CLOSED=True \
    ENABLE_DEMO=False \
    CORS_ORIGINS=<the calling app's origin> \
    API_KEY=secretref:api-key \
    QDRANT_API_KEY=secretref:qdrant-key \
    API_KEYS=secretref:gate-key
```

`PORT` is injected by the platform — do not set it. The container binds
`${PORT:-8000}`.

## Verify

```bash
FQDN=$(az containerapp show -n policy-gate -g rg-policy-gate \
        --query properties.configuration.ingress.fqdn -o tsv)

curl https://$FQDN/health
```

Expect `"status":"ok"`, a non-zero `policy_chunks`, `model_credentials":"ok"`,
and `embed_dimension` matching what the collection was seeded at. A `degraded`
status or `policy_chunks: 0` means the container is healthy and the corpus is
not — every request would deny, with a reason that reads like strict policy
rather than missing configuration.

Then confirm the key check is live:

```bash
# expect 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://$FQDN/api/policy/evaluate \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"release payment for INV-8842","actor":{"user_id":"x","role":"finance_manager"}}'
```

If that returns 200, `API_KEYS` did not reach the container and the gate is
open. The startup log says `auth=OFF` in that case.

## Scaling

```bash
az containerapp update --name policy-gate --resource-group rg-policy-gate \
  --min-replicas 0 --max-replicas 2
```

`min-replicas 0` scales to zero and costs nothing idle, at the price of a cold
start of a few seconds on the first request. Note the Gemini free tier is **15
requests/minute across the whole project**, so replicas share one quota — more
replicas do not buy more throughput, and a 429 reaches the gate as a denial.
`API_MAX_RETRIES=8` exists to ride out that window.

## Local equivalent

```bash
docker build -t policy-gate .
docker run --rm -p 8000:8080 -e PORT=8080 -e API_KEYS=local-dev-key \
  --env-file .env policy-gate
```

**No trailing comments on assignments in `.env`.** python-dotenv strips them,
Docker's `--env-file` does not, so `QDRANT_TIMEOUT=60  # seconds` arrives as the
literal string `"60  # seconds"` and the container dies on startup validation.

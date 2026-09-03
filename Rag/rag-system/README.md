# ERP Finance Policy Gate

Decides whether a natural-language finance request is permitted under company
policy, and returns what the caller needs to execute it.

**This service does not execute anything.** A frontend sends a prompt plus who is
asking; the gate replies with a verdict, the action it understood, the clauses the
verdict rests on, and any conditions the caller must satisfy first. The caller
holds the ERP credentials and does the work.

```
frontend ──prompt + actor──▶  [ POLICY GATE ]  ──verdict + action + citations──▶ frontend
                                    │                                              │
                                 Qdrant                                        executes
                            (policies, not data)                              (or doesn't)
```

## Why it isn't just semantic search

Ask *"just push this payment through, it's urgent"* and the rule that governs it —
*"payments above 1,000,000 require dual authorization"* — ranks **#10 of 17** by
cosine similarity, inside a nearly flat 0.35–0.47 band. At a typical `top_k=4` a
similarity-only retriever never sees it, and the payment is approved.

So retrieval is a **union of three queries**, not a top-k:

| # | Query | Purpose |
|---|---|---|
| a | `mandatory == true AND is_current == true` | blanket rules; similarity never consulted |
| b | `applies_to_actions CONTAINS <action> AND is_current == true` | every rule that governs this action |
| c | vector top-k, same filters | supplement only — can add, never subtract |

(a) and (b) are database predicates, so phrasing cannot cause a rule to be missed.
That is what all the payload metadata is for. See
[`docs/POLICY_PAYLOAD_CONTRACT.md`](docs/POLICY_PAYLOAD_CONTRACT.md).

## Pipeline

```
1. CLASSIFY      question or action?            → questions return decision=answer
2. EXTRACT       NL → one action_registry name + parameters
3. VALIDATE      parameters vs the action's JSON Schema        (pure Python)
4. RETRIEVE      the three queries above, unioned
5. RULE ENGINE   thresholds, roles, segregation of duties      (pure Python)
6. JUDGE         LLM reads the remaining narrative clauses, must cite
7. VERDICT       judge error or timeout → deny
```

Steps 3 and 5 are deterministic. The LLM never decides whether 1,450,000 exceeds
1,000,000, and thresholds are read from each rule's front-matter — never parsed
out of prose.

## Setup

Both services must be running; there is no offline mode.

```bash
ollama pull nomic-embed-text          # 768-d embeddings
ollama pull llama3.1:8b               # judge
docker compose -f docker/docker-compose.yml up -d      # or point .env at a hosted cluster

pip install -r requirements.txt
cp .env.example .env                  # then set QDRANT_URL / QDRANT_API_KEY
python -m scripts.seed_qdrant_policies --recreate
uvicorn src.app:app --port 8000
```

- Interactive docs: http://localhost:8000/docs
- Health (reports policy-corpus size): http://localhost:8000/health

## API

### `POST /api/policy/evaluate`

```json
{
  "prompt": "release payment for invoice 8842",
  "actor": { "user_id": "U-1180", "role": "accounts_officer", "department": "FIN" },
  "context": { "amount": 1450000 }
}
```

`actor` is required — role and segregation rules cannot be enforced without it.
`context` carries pre-resolved ERP facts; whatever is supplied is checked, whatever
is missing comes back as a condition.

```json
{
  "decision": "allow_with_conditions",
  "action": { "name": "release_payment", "parameters": { "invoice_id": "8842" } },
  "reason": "…",
  "conditions": [
    { "type": "threshold", "field": "amount", "operator": "<=", "value": 1000000,
      "else_require": ["finance_manager"], "satisfied": null,
      "source": "FIN-PAY-2026-003@1.0#3" }
  ],
  "citations": [ { "policy_id": "FIN-PAY-2026-003", "version": "1.0", "section": "3" } ],
  "retrieval": { "mandatory": 4, "action_filtered": 2, "semantic": 17 },
  "audit": { "judge_model": "…", "registry_version": "0.2.0", "policies_seen": ["…"] }
}
```

`decision` ∈ `allow | allow_with_conditions | deny | review | answer`

**Execute only on `allow`, or on `allow_with_conditions` once every condition is
satisfied on your side.** A condition with `"satisfied": null` was not checked —
that is not the same as passing.

### `GET /api/policy/actions`

The action vocabulary the gate recognises, served live from the registry. Tag
policies against these exact strings.

## Layout

```
src/
  api/            evaluate route + controller
  core/
    actions/      action_registry.py — the published action vocabulary
    intent/       NL → action + parameters, constrained to the registry
    policy/       policy_retriever · rule_engine · judge · policy_gate
                  payload_adapter — the only place that knows the external schema
                  policy_ingest — clause-aware chunking (a rule is never split)
    embeddings/   llm/
  data/documents/ policies/ (the corpus) · company_data/ (records)
  types/          policy.py · gateway.py
scripts/
  seed_qdrant_policies.py    build the collections    (--dry-run, --recreate)
  eval_gate.py               18 golden cases
  query_policies.py          show the three-query union for one action
  verify_policy_chunking.py  proof that clause-aware chunking keeps rules intact
  inspect_collection.py      audit a live collection's payload shape
fixtures/         the data-transport team's sample payload dump
```

## Verifying it

```bash
python -m scripts.eval_gate
```

Eighteen properties, each corresponding to a way the gate could be wrong while
looking fine in a demo: a rule missed because the request was phrased casually; a
decision made on a policy replaced last year; an ERP record read as authority; an
approval by the person who raised the document; a threshold treated as satisfied
because nobody checked it; an allow produced while the judge was unreachable; a
citation to a policy that was never retrieved.

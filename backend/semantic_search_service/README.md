# Embedding Semantic Search Service

This service performs dataset-backed semantic retrieval for the Go backend.

It loads JSON files from `../dataset`, embeds tool/rule/template/scenario documents using a local Ollama embedding model, builds an in-memory FAISS index, and exposes:

```http
POST /search
GET /health
```

Run:

```powershell
ollama pull nomic-embed-text
cd "C:\Users\LKsnj\Desktop\RESEARCH_LAKSHAN\IMPLIMENTATION\low-code-workflow-engine\backend\semantic_search_service"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:DATASET_ROOT="..\dataset"
$env:EMBEDDING_PROVIDER="ollama"
$env:OLLAMA_EMBEDDING_BASE_URL="http://localhost:11434"
$env:OLLAMA_EMBEDDING_MODEL="nomic-embed-text"
$env:INDEX_PROFILE="dev"
$env:INDEX_MAX_ITEMS_PER_FILE="25"
$env:EMBED_BATCH_SIZE="32"
$env:EMBEDDING_TEXT_MAX_CHARS="2000"
$env:REBUILD_SEMANTIC_INDEX="false"
$env:INDEX_INCLUDE_TOOLS="true"
$env:INDEX_INCLUDE_RULES="true"
$env:INDEX_INCLUDE_TEMPLATES="true"
$env:INDEX_INCLUDE_EXAMPLES="true"
$env:INDEX_INCLUDE_VALIDATOR_CASES="false"
$env:SEMANTIC_SEARCH_LOG_LEVEL="INFO"
uvicorn app:app --host 127.0.0.1 --port 8090
```

The Go backend calls:

```env
SEMANTIC_SEARCH_URL=http://localhost:8090/search
SEMANTIC_SEARCH_MODE=external_embedding
```

Gemini is not used for semantic search. Gemini is only used by the Go backend for YAML workflow generation.

For a full research-scale index, set:

```powershell
$env:INDEX_PROFILE="full"
$env:INDEX_MAX_ITEMS_PER_FILE="0"
```

The full index takes longer because every dataset item is embedded through Ollama.

If Ollama rejects a large embedding batch, reduce the request size:

```powershell
$env:EMBED_BATCH_SIZE="8"
$env:EMBEDDING_TEXT_MAX_CHARS="1500"
```

The service also splits failed batches automatically before falling back to single-item embedding calls.

## Index Cache

The first startup builds embeddings and writes a cache under:

```text
semantic_search_service/.cache/
```

Files:

```text
index_<fingerprint>.faiss
documents_<fingerprint>.json
embeddings_<fingerprint>.npy
metadata_<fingerprint>.json
```

Second startup with the same dataset/config loads from cache quickly.

Check cache/index status:

```text
GET http://127.0.0.1:8090/index/status
```

Force rebuild:

```powershell
$env:REBUILD_SEMANTIC_INDEX="true"
uvicorn app:app --host 127.0.0.1 --port 8090
```

Or call:

```text
POST http://127.0.0.1:8090/index/rebuild
```

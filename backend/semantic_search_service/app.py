from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request
from hashlib import sha256
from pathlib import Path
from typing import Any, Dict, List

import faiss
import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel


def default_max_items(profile: str) -> str:
    if profile == "quick":
        return "10"
    if profile == "dev":
        return "25"
    return "0"


SERVICE_DIR = Path(__file__).resolve().parent
BACKEND_ROOT = SERVICE_DIR.parent


def load_env_files() -> None:
    candidates = [
        SERVICE_DIR / ".env.local",
        SERVICE_DIR / ".env",
        BACKEND_ROOT / ".env.local",
        BACKEND_ROOT / ".env.development",
        BACKEND_ROOT / ".env",
    ]
    for path in candidates:
        if not path.exists():
            continue
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            if line.startswith("export "):
                line = line[len("export ") :].strip()
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip("'\"")
            if key and key not in os.environ:
                os.environ[key] = value


def resolve_dataset_root(value: str) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path.resolve()
    candidates = [
        Path.cwd() / path,
        BACKEND_ROOT / path,
        SERVICE_DIR / path,
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate.resolve()
    return (BACKEND_ROOT / path).resolve()


def int_env(name: str, fallback: Any) -> int:
    try:
        return int(os.getenv(name, str(fallback)))
    except ValueError:
        return int(fallback)


load_env_files()

DATASET_ROOT = resolve_dataset_root(os.getenv("DATASET_ROOT", "../dataset"))
EMBEDDING_PROVIDER = os.getenv("EMBEDDING_PROVIDER", "ollama").strip().lower()
MODEL_NAME = os.getenv("EMBEDDING_MODEL", os.getenv("OLLAMA_EMBEDDING_MODEL", "nomic-embed-text"))
OLLAMA_BASE_URL = os.getenv("OLLAMA_EMBEDDING_BASE_URL", "http://localhost:11434").rstrip("/")
RETRIEVAL_METHOD = f"embedding_faiss_{EMBEDDING_PROVIDER}_{MODEL_NAME.replace('/', '_')}"
INDEX_PROFILE = os.getenv("INDEX_PROFILE", "dev").strip().lower()
MAX_ITEMS_PER_FILE = int_env("INDEX_MAX_ITEMS_PER_FILE", default_max_items(INDEX_PROFILE))
MAX_ITEMS_BY_KIND = {
    "tool": int_env("INDEX_MAX_TOOLS_PER_FILE", 0),
    "rule": int_env("INDEX_MAX_RULES_PER_FILE", 0),
    "template": int_env("INDEX_MAX_TEMPLATES_PER_FILE", MAX_ITEMS_PER_FILE),
    "example": int_env("INDEX_MAX_EXAMPLES_PER_FILE", MAX_ITEMS_PER_FILE),
}
EMBED_BATCH_SIZE = int_env("EMBED_BATCH_SIZE", 32)
EMBEDDING_TEXT_MAX_CHARS = int_env("EMBEDDING_TEXT_MAX_CHARS", 2000)
OLLAMA_TIMEOUT_SECONDS = int_env("OLLAMA_EMBEDDING_TIMEOUT_SECONDS", 60)
REBUILD_SEMANTIC_INDEX = os.getenv("REBUILD_SEMANTIC_INDEX", "false").lower() in {"1", "true", "yes"}
INDEX_INCLUDE_TOOLS = os.getenv("INDEX_INCLUDE_TOOLS", "true").lower() in {"1", "true", "yes"}
INDEX_INCLUDE_RULES = os.getenv("INDEX_INCLUDE_RULES", "true").lower() in {"1", "true", "yes"}
INDEX_INCLUDE_TEMPLATES = os.getenv("INDEX_INCLUDE_TEMPLATES", "true").lower() in {"1", "true", "yes"}
INDEX_INCLUDE_EXAMPLES = os.getenv("INDEX_INCLUDE_EXAMPLES", "true").lower() in {"1", "true", "yes"}
INDEX_INCLUDE_VALIDATOR_CASES = os.getenv("INDEX_INCLUDE_VALIDATOR_CASES", "false").lower() in {"1", "true", "yes"}
CACHE_DIR = Path(os.getenv("SEMANTIC_INDEX_CACHE_DIR", ".cache")).resolve()
LOG_LEVEL = os.getenv("SEMANTIC_SEARCH_LOG_LEVEL", "INFO").upper()

logging.basicConfig(level=LOG_LEVEL, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("semantic-search")


class SearchRequest(BaseModel):
    query: str
    user_role: str = ""
    top_k_tools: int = 10
    top_k_rules: int = 15
    top_k_templates: int = 5
    top_k_examples: int = 5


class SearchDocument:
    def __init__(self, kind: str, doc_id: str, name: str, source_file: str, original: Dict[str, Any], text: str):
        self.kind = kind
        self.doc_id = doc_id
        self.name = name
        self.source_file = source_file
        self.original = original
        self.text = text


app = FastAPI(title="Workflow Dataset Semantic Search", version="1.0")
embedder: Any = None
index: faiss.IndexFlatIP | None = None
documents: List[SearchDocument] = []
cache_hit: bool = False
fingerprint: str = ""
startup_seconds: float = 0.0
index_dimensions: int = 0


@app.on_event("startup")
def startup() -> None:
    global embedder, index, documents, cache_hit, fingerprint, startup_seconds, index_dimensions
    started = time.perf_counter()
    log.info("semantic search startup: dataset_root=%s provider=%s model=%s profile=%s max_items_per_file=%s max_items_by_kind=%s text_max_chars=%d",
             DATASET_ROOT, EMBEDDING_PROVIDER, MODEL_NAME, INDEX_PROFILE, MAX_ITEMS_PER_FILE or "full", MAX_ITEMS_BY_KIND, EMBEDDING_TEXT_MAX_CHARS)
    documents = load_documents(DATASET_ROOT)
    log.info("loaded %d search documents", len(documents))
    embedder = build_embedder()
    fingerprint = compute_fingerprint(DATASET_ROOT)
    log.info("semantic index fingerprint=%s cache_dir=%s rebuild=%s", fingerprint, CACHE_DIR, REBUILD_SEMANTIC_INDEX)
    if not documents:
        index = faiss.IndexFlatIP(384)
        index_dimensions = 384
        log.warning("no documents found; empty FAISS index created")
        startup_seconds = round(time.perf_counter() - started, 3)
        return
    if not REBUILD_SEMANTIC_INDEX and load_cache(fingerprint):
        cache_hit = True
        startup_seconds = round(time.perf_counter() - started, 3)
        log.info("Loaded semantic index from cache fingerprint=%s documents=%d dimensions=%d startup_seconds=%.3f",
                 fingerprint, len(documents), index_dimensions, startup_seconds)
        return
    cache_hit = False
    log.info("cache miss for fingerprint=%s", fingerprint)
    log.info("embedding %d documents in batches of %d", len(documents), EMBED_BATCH_SIZE)
    vectors = embed_texts([doc.text for doc in documents])
    vectors = np.asarray(vectors, dtype="float32")
    vectors = normalize(vectors)
    index = faiss.IndexFlatIP(vectors.shape[1])
    index.add(vectors)
    index_dimensions = int(vectors.shape[1])
    save_cache(fingerprint, vectors)
    startup_seconds = round(time.perf_counter() - started, 3)
    log.info("FAISS index ready: documents=%d dimensions=%d method=%s startup_seconds=%.3f", len(documents), vectors.shape[1], RETRIEVAL_METHOD, startup_seconds)


@app.get("/health")
def health() -> Dict[str, Any]:
    return {
        "status": "ok",
        "dataset_root": str(DATASET_ROOT),
        "embedding_provider": EMBEDDING_PROVIDER,
        "embedding_model": MODEL_NAME,
        "ollama_base_url": OLLAMA_BASE_URL if EMBEDDING_PROVIDER == "ollama" else "",
        "documents": len(documents),
        "method": RETRIEVAL_METHOD,
        "index_profile": INDEX_PROFILE,
        "max_items_per_file": MAX_ITEMS_PER_FILE,
        "max_items_by_kind": MAX_ITEMS_BY_KIND,
        "cache_enabled": True,
        "cache_hit": cache_hit,
        "fingerprint": fingerprint,
        "startup_seconds": startup_seconds,
    }


@app.get("/index/status")
def index_status() -> Dict[str, Any]:
    return {
        "ready": index is not None and bool(documents),
        "dataset_root": str(DATASET_ROOT),
        "retrieval_method": RETRIEVAL_METHOD,
        "document_count": len(documents),
        "index_profile": INDEX_PROFILE,
        "max_items_by_kind": MAX_ITEMS_BY_KIND,
        "cache_enabled": True,
        "cache_hit": cache_hit,
        "fingerprint": fingerprint,
        "embedding_provider": EMBEDDING_PROVIDER,
        "embedding_model": MODEL_NAME,
        "faiss_index_size": int(index.ntotal) if index is not None else 0,
        "index_dimensions": index_dimensions,
        "startup_seconds": startup_seconds,
    }


@app.post("/index/rebuild")
def rebuild_index() -> Dict[str, Any]:
    try:
        rebuild()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return index_status()


@app.post("/search")
def search(req: SearchRequest) -> Dict[str, Any]:
    if embedder is None or index is None or not documents:
        return empty_response(req.query)
    top_k = min(len(documents), max(req.top_k_tools + req.top_k_rules + req.top_k_templates + req.top_k_examples + 20, 50))
    query_vector = embed_texts([req.query])
    query_vector = np.asarray(query_vector, dtype="float32")
    query_vector = normalize(query_vector)
    scores, indexes = index.search(query_vector, top_k)

    buckets: Dict[str, List[Dict[str, Any]]] = {"tool": [], "rule": [], "template": [], "example": []}
    limits = {
        "tool": req.top_k_tools,
        "rule": req.top_k_rules,
        "template": req.top_k_templates,
        "example": req.top_k_examples,
    }
    for score, idx in zip(scores[0], indexes[0]):
        if idx < 0:
            continue
        doc = documents[int(idx)]
        if len(buckets[doc.kind]) >= limits[doc.kind]:
            continue
        buckets[doc.kind].append(to_result(doc, float(score)))

    return {
        "query": req.query,
        "retrieval_method": RETRIEVAL_METHOD,
        "tools": buckets["tool"],
        "rules": buckets["rule"],
        "templates": buckets["template"],
        "examples": buckets["example"],
    }


def empty_response(query: str) -> Dict[str, Any]:
    return {
        "query": query,
        "retrieval_method": RETRIEVAL_METHOD,
        "tools": [],
        "rules": [],
        "templates": [],
        "examples": [],
    }


def build_embedder() -> Any:
    if EMBEDDING_PROVIDER == "ollama":
        log.info("using Ollama embeddings at %s with model %s", OLLAMA_BASE_URL, MODEL_NAME)
        return {"provider": "ollama", "model": MODEL_NAME}
    if EMBEDDING_PROVIDER in {"sentence_transformers", "sentence-transformers", "local_sentence_transformers"}:
        from sentence_transformers import SentenceTransformer

        return SentenceTransformer(MODEL_NAME)
    raise RuntimeError(f"Unsupported EMBEDDING_PROVIDER={EMBEDDING_PROVIDER!r}")


def embed_texts(texts: List[str]) -> np.ndarray:
    if not texts:
        return np.zeros((0, 0), dtype="float32")
    texts = [truncate_text(text) for text in texts]
    batches = [texts[i : i + EMBED_BATCH_SIZE] for i in range(0, len(texts), EMBED_BATCH_SIZE)]
    vectors = []
    for idx, batch in enumerate(batches, start=1):
        log.info("embedding batch %d/%d size=%d", idx, len(batches), len(batch))
        vectors.append(embed_batch(batch))
    return np.vstack(vectors).astype("float32")


def embed_batch(texts: List[str]) -> np.ndarray:
    if EMBEDDING_PROVIDER == "ollama":
        return ollama_embed(texts)
    vectors = embedder.encode(texts, normalize_embeddings=False, show_progress_bar=False)
    return np.asarray(vectors, dtype="float32")


def ollama_embed(texts: List[str]) -> np.ndarray:
    payload = json.dumps({"model": MODEL_NAME, "input": texts}).encode("utf-8")
    request = urllib.request.Request(
        f"{OLLAMA_BASE_URL}/api/embed",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=OLLAMA_TIMEOUT_SECONDS) as response:
            data = json.loads(response.read().decode("utf-8"))
        embeddings = data.get("embeddings")
        if embeddings:
            return np.asarray(embeddings, dtype="float32")
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        if len(texts) > 1:
            log.warning("Ollama batch /api/embed failed for size=%d, splitting batch: %s", len(texts), exc)
            midpoint = len(texts) // 2
            left = ollama_embed(texts[:midpoint])
            right = ollama_embed(texts[midpoint:])
            return np.vstack([left, right]).astype("float32")
        log.warning("Ollama single /api/embed failed, falling back to /api/embeddings: %s", exc)

    # Older Ollama versions expose /api/embeddings for one prompt at a time.
    vectors = []
    for text in texts:
        payload = json.dumps({"model": MODEL_NAME, "prompt": text}).encode("utf-8")
        request = urllib.request.Request(
            f"{OLLAMA_BASE_URL}/api/embeddings",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=OLLAMA_TIMEOUT_SECONDS) as response:
                data = json.loads(response.read().decode("utf-8"))
        except Exception as exc:
            raise RuntimeError("Embedding provider failed. Check Ollama is running and model exists.") from exc
        vectors.append(data["embedding"])
    return np.asarray(vectors, dtype="float32")


def truncate_text(text: str) -> str:
    if EMBEDDING_TEXT_MAX_CHARS <= 0:
        return text
    if len(text) <= EMBEDDING_TEXT_MAX_CHARS:
        return text
    return text[:EMBEDDING_TEXT_MAX_CHARS]


def normalize(vectors: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    norms[norms == 0] = 1
    return (vectors / norms).astype("float32")


def to_result(doc: SearchDocument, score: float) -> Dict[str, Any]:
    result = {
        "id": doc.doc_id,
        "name": doc.name,
        "score": round(score, 6),
        "match_reason": f"Embedding similarity with {doc.kind} document",
        "source_file": doc.source_file,
        "original": doc.original,
    }
    if doc.kind == "rule":
        result["rule_id"] = doc.doc_id
        result["rule_name"] = doc.name
    if doc.kind == "tool":
        result["display_name"] = doc.original.get("display_name", "")
        result["module"] = doc.original.get("module", "")
    return result


def load_documents(root: Path) -> List[SearchDocument]:
    docs: List[SearchDocument] = []
    specs = []
    if INDEX_INCLUDE_TOOLS:
        specs.append(("tool", root / "01_tool_registries", tool_text, "tool_id", "name"))
    if INDEX_INCLUDE_RULES:
        specs.append(("rule", root / "02_governance_rules", rule_text, "rule_id", "rule_name"))
    if INDEX_INCLUDE_TEMPLATES:
        specs.append(("template", root / "03_process_templates", template_text, "template_id", "template_name"))
    if INDEX_INCLUDE_EXAMPLES:
        specs.append(("example", root / "04_test_scenarios", example_text, "scenario_id", "user_request"))
    if INDEX_INCLUDE_VALIDATOR_CASES:
        specs.append(("example", root / "05_validator_cases", validator_case_text, "case_id", "test_focus"))
    for kind, folder, builder, id_key, name_key in specs:
        if not folder.exists():
            log.warning("dataset folder missing: %s", folder)
            continue
        for file in sorted(folder.glob("*.json")):
            try:
                items = json.loads(file.read_text(encoding="utf-8"))
            except Exception as exc:
                log.warning("skipping invalid json file %s: %s", file, exc)
                continue
            if not isinstance(items, list):
                continue
            limit = max_items_for_kind(kind)
            if limit > 0:
                original_count = len(items)
                items = balanced_sample(items, limit)
                log.info("loaded %s kind=%s sampled=%d/%d", file.name, kind, len(items), original_count)
            else:
                log.info("loaded %s kind=%s count=%d", file.name, kind, len(items))
            for item in items:
                if not isinstance(item, dict):
                    continue
                doc_id = str(item.get(id_key) or item.get(name_key) or "")
                name = str(item.get(name_key) or doc_id)
                if not doc_id:
                    continue
                source = file.relative_to(root).as_posix()
                docs.append(SearchDocument(kind, doc_id, name, source, item, builder(item)))
    return dedupe(docs)


def max_items_for_kind(kind: str) -> int:
    return MAX_ITEMS_BY_KIND.get(kind, MAX_ITEMS_PER_FILE)


def balanced_sample(items: List[Dict[str, Any]], limit: int) -> List[Dict[str, Any]]:
    if len(items) <= limit:
        return items
    if limit <= 0:
        return items
    if limit == 1:
        return [items[0]]
    indexes = np.linspace(0, len(items) - 1, num=limit, dtype=int)
    sampled = []
    seen = set()
    for idx in indexes:
        if int(idx) in seen:
            continue
        seen.add(int(idx))
        sampled.append(items[int(idx)])
    return sampled


def dedupe(docs: List[SearchDocument]) -> List[SearchDocument]:
    seen = set()
    out = []
    for doc in docs:
        key = (doc.kind, doc.doc_id)
        if key in seen:
            continue
        seen.add(key)
        out.append(doc)
    return out


def tool_text(item: Dict[str, Any]) -> str:
    return join_text(
        item.get("tool_id"),
        item.get("name"),
        item.get("display_name"),
        item.get("module"),
        item.get("description"),
        item.get("business_capability"),
        item.get("required_parameters"),
        item.get("optional_parameters"),
        item.get("allowed_roles"),
        item.get("risk_level"),
        item.get("semantic_search_keywords"),
        item.get("semantic_search_description"),
        item.get("bpi_process_alignment"),
        item.get("current_gaps"),
    )


def rule_text(item: Dict[str, Any]) -> str:
    return join_text(
        item.get("rule_id"),
        item.get("rule_name"),
        item.get("rule_type"),
        item.get("domain"),
        item.get("description"),
        item.get("applies_to_tools"),
        item.get("applies_to_roles"),
        item.get("condition"),
        item.get("enforcement_action"),
        item.get("severity"),
        item.get("validator_message"),
        item.get("llm_prompt_instruction"),
        item.get("healing_guidance"),
        item.get("bpi_alignment"),
    )


def template_text(item: Dict[str, Any]) -> str:
    return join_text(
        item.get("template_id"),
        item.get("template_name"),
        item.get("description"),
        item.get("required_tools"),
        item.get("required_rules"),
        item.get("normal_flow"),
        item.get("exception_flows"),
        item.get("sample_user_intents"),
        item.get("bpi_alignment"),
    )


def example_text(item: Dict[str, Any]) -> str:
    return join_text(
        item.get("user_request"),
        item.get("expected_domain"),
        item.get("expected_intent"),
        item.get("expected_tools"),
        item.get("expected_rules"),
        item.get("expected_decision"),
        item.get("notes"),
        item.get("bpi_alignment"),
    )


def join_text(*values: Any) -> str:
    parts: List[str] = []
    for value in values:
        if value is None:
            continue
        if isinstance(value, (dict, list)):
            parts.append(json.dumps(value, ensure_ascii=False))
        else:
            parts.append(str(value))
    return " ".join(parts)


def validator_case_text(item: Dict[str, Any]) -> str:
    return join_text(
        item.get("case_id"),
        item.get("user_role"),
        item.get("workflow_candidate"),
        item.get("expected_result"),
        item.get("expected_failed_rules"),
        item.get("expected_validator_message"),
        item.get("test_focus"),
    )


def compute_fingerprint(root: Path) -> str:
    payload: Dict[str, Any] = {
        "dataset_root": str(root.resolve()),
        "index_profile": INDEX_PROFILE,
        "max_items_per_file": MAX_ITEMS_PER_FILE,
        "max_items_by_kind": MAX_ITEMS_BY_KIND,
        "embedding_provider": EMBEDDING_PROVIDER,
        "embedding_model": MODEL_NAME,
        "include_tools": INDEX_INCLUDE_TOOLS,
        "include_rules": INDEX_INCLUDE_RULES,
        "include_templates": INDEX_INCLUDE_TEMPLATES,
        "include_examples": INDEX_INCLUDE_EXAMPLES,
        "include_validator_cases": INDEX_INCLUDE_VALIDATOR_CASES,
        "files": [],
    }
    folders = []
    if INDEX_INCLUDE_TOOLS:
        folders.append(root / "01_tool_registries")
    if INDEX_INCLUDE_RULES:
        folders.append(root / "02_governance_rules")
    if INDEX_INCLUDE_TEMPLATES:
        folders.append(root / "03_process_templates")
    if INDEX_INCLUDE_EXAMPLES:
        folders.append(root / "04_test_scenarios")
    if INDEX_INCLUDE_VALIDATOR_CASES:
        folders.append(root / "05_validator_cases")
    for folder in folders:
        if not folder.exists():
            continue
        for file in sorted(folder.glob("*.json")):
            stat = file.stat()
            payload["files"].append(
                {
                    "name": file.relative_to(root).as_posix(),
                    "mtime_ns": stat.st_mtime_ns,
                    "size": stat.st_size,
                }
            )
    raw = json.dumps(payload, sort_keys=True).encode("utf-8")
    return sha256(raw).hexdigest()[:24]


def cache_paths(fp: str) -> Dict[str, Path]:
    return {
        "index": CACHE_DIR / f"index_{fp}.faiss",
        "documents": CACHE_DIR / f"documents_{fp}.json",
        "embeddings": CACHE_DIR / f"embeddings_{fp}.npy",
        "metadata": CACHE_DIR / f"metadata_{fp}.json",
    }


def load_cache(fp: str) -> bool:
    global index, documents, index_dimensions
    paths = cache_paths(fp)
    if not all(path.exists() for path in paths.values()):
        return False
    try:
        cached_docs = json.loads(paths["documents"].read_text(encoding="utf-8"))
        documents = [document_from_dict(item) for item in cached_docs]
        loaded_index = faiss.read_index(str(paths["index"]))
        metadata = json.loads(paths["metadata"].read_text(encoding="utf-8"))
        index = loaded_index
        index_dimensions = int(metadata.get("index_dimensions", 0))
        return True
    except Exception as exc:
        log.warning("failed to load semantic index cache: %s", exc)
        return False


def save_cache(fp: str, vectors: np.ndarray) -> None:
    if index is None:
        return
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    paths = cache_paths(fp)
    faiss.write_index(index, str(paths["index"]))
    paths["documents"].write_text(json.dumps([document_to_dict(doc) for doc in documents], ensure_ascii=False), encoding="utf-8")
    np.save(paths["embeddings"], vectors)
    metadata = {
        "fingerprint": fp,
        "dataset_root": str(DATASET_ROOT),
        "retrieval_method": RETRIEVAL_METHOD,
        "document_count": len(documents),
        "index_profile": INDEX_PROFILE,
        "max_items_per_file": MAX_ITEMS_PER_FILE,
        "max_items_by_kind": MAX_ITEMS_BY_KIND,
        "embedding_provider": EMBEDDING_PROVIDER,
        "embedding_model": MODEL_NAME,
        "index_dimensions": int(vectors.shape[1]),
        "created_at_unix": time.time(),
    }
    paths["metadata"].write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    log.info("Saved semantic index cache fingerprint=%s documents=%d path=%s", fp, len(documents), CACHE_DIR)


def document_to_dict(doc: SearchDocument) -> Dict[str, Any]:
    return {
        "kind": doc.kind,
        "doc_id": doc.doc_id,
        "name": doc.name,
        "source_file": doc.source_file,
        "original": doc.original,
        "text": doc.text,
    }


def document_from_dict(item: Dict[str, Any]) -> SearchDocument:
    return SearchDocument(
        kind=item["kind"],
        doc_id=item["doc_id"],
        name=item["name"],
        source_file=item["source_file"],
        original=item["original"],
        text=item["text"],
    )


def rebuild() -> None:
    global embedder, index, documents, cache_hit, fingerprint, startup_seconds, index_dimensions
    started = time.perf_counter()
    documents = load_documents(DATASET_ROOT)
    embedder = build_embedder()
    fingerprint = compute_fingerprint(DATASET_ROOT)
    if not documents:
        index = faiss.IndexFlatIP(384)
        index_dimensions = 384
        cache_hit = False
        startup_seconds = round(time.perf_counter() - started, 3)
        return
    log.info("manual rebuild: embedding %d documents", len(documents))
    vectors = normalize(np.asarray(embed_texts([doc.text for doc in documents]), dtype="float32"))
    index = faiss.IndexFlatIP(vectors.shape[1])
    index.add(vectors)
    index_dimensions = int(vectors.shape[1])
    save_cache(fingerprint, vectors)
    cache_hit = False
    startup_seconds = round(time.perf_counter() - started, 3)
    log.info("manual rebuild complete fingerprint=%s startup_seconds=%.3f", fingerprint, startup_seconds)

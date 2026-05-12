# Semantic Search Service

The `semantic_search_service` is a standalone Python application that provides vector-based search capabilities for the workflow engine.

## Overview

- **Framework**: Built with **FastAPI**.
- **Vector Search**: Uses **FAISS** (Facebook AI Similarity Search) for efficient nearest-neighbor search.
- **Embeddings**: Supports multiple embedding backends, including:
  - `SentenceTransformer` (Local CPU/GPU execution).
  - `Ollama` API (Delegated embedding generation).

## Core Logic (`app.py`)

- **Startup**: On startup, the service crawls the `dataset/` directory and generates embeddings for all tools, rules, templates, and examples.
- **Indexing**: These embeddings are stored in a FAISS index (`IndexFlatIP`) for fast retrieval.
- **Search Endpoint (`/search`)**: Accepts a query string and returns the top-K most relevant documents along with their metadata.

## Cache

The service maintains a local `.cache/` directory to store pre-computed embeddings and FAISS indices, significantly speeding up subsequent restarts.

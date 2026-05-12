# Semantic Search Service Bridge

The `internal/core/semanticsearch` package provides context retrieval capabilities for the engine.

## Service (`service.go`)

The `Service` acts as a facade for searching relevant context (tools, rules, templates) based on a natural language query. It supports multiple search strategies:
- **External Embedding Search**: Calls the Python-based `semantic_search_service` for vector-based retrieval using FAISS and embeddings.
- **Internal Lexical Search**: A fallback token-based scoring mechanism implemented in Go.

## Document Builder (`document_builder.go`)

Responsible for flattening complex JSON structures (like tool definitions and rule descriptions) into plain text "documents" that can be indexed and searched by the embedding service.

## Similarity (`similarity.go`)

Contains utility functions for calculating lexical similarity and ranking search results.

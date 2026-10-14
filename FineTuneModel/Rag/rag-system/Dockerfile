# ERP Finance Policy Gate — container image.
#
# The image holds the API and nothing else. No model weights, no Ollama, no GPU:
# the LLM and the embedding model are reached over HTTP (MODEL_PROVIDER=api) and
# the vector store is Qdrant Cloud. That is what makes this deployable on a
# small serverless container platform at all — the same app with a local Ollama
# needs several GB of RAM and a model pull on every cold start.
#
# BUILD (from rag-system/)
#   docker build -t policy-gate .
#
# RUN
#   docker run --rm -p 8000:8000 --env-file .env policy-gate
#
# The corpus is NOT seeded by this image. Seeding writes to a shared Qdrant
# collection, and a container that re-seeds on boot would rewrite the corpus
# every time the platform scaled it out. Run it once, from anywhere:
#   python -m scripts.seed_qdrant_policies --recreate

FROM python:3.13-slim AS base

# - PYTHONDONTWRITEBYTECODE: no .pyc in a read-only-ish container layer
# - PYTHONUNBUFFERED: logs appear in `docker logs` as they happen, not at exit,
#   which is the difference between watching a startup failure and guessing
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app

WORKDIR /app

# Dependencies first, in their own layer. requirements.txt changes rarely and
# source changes constantly; copying source first would reinstall every package
# on every edit.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/
COPY scripts/ ./scripts/

# Run as a non-root user. A container process that does not need to write to the
# filesystem should not be able to.
RUN useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app
USER appuser

# Documentation only — the platform decides the real port via $PORT.
EXPOSE 8000

# $PORT is injected by Azure Container Apps, Cloud Run, and Railway; 8000 is the
# local default. Shell form is required here so the variable is expanded.
CMD uvicorn src.app:app --host 0.0.0.0 --port ${PORT:-8000}

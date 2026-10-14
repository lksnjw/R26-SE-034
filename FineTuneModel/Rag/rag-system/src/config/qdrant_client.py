"""
Lazy Qdrant client factory.
Only instantiated when RETRIEVER=qdrant — importing this file is always safe.
"""
from functools import lru_cache
from qdrant_client import QdrantClient
from src.config.settings import settings


@lru_cache(maxsize=1)
def get_qdrant_client() -> QdrantClient:
    """Return a cached QdrantClient.  Called only by QdrantRetriever."""
    return QdrantClient(
        url=settings.QDRANT_URL,
        api_key=settings.QDRANT_API_KEY,
        timeout=settings.QDRANT_TIMEOUT,
    )

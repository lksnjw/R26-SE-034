"""
Embedding service — the only place the embedding backend is chosen.

Follows `MODEL_PROVIDER` like `llm_service`, but the stakes are different. A chat
model that changes gives different prose; an embedding model that changes puts
queries in a different vector space from the index, and Qdrant reports no error
for that — it returns whatever happens to be nearest in a space the query does
not belong to. There is no symptom except worse answers.

So: after changing EMBED_MODEL or the provider, re-seed.

    .venv/Scripts/python.exe -m scripts.seed_qdrant_policies --recreate

`nomic-ai/nomic-embed-text-v1` on OpenRouter is the same model family as Ollama's
`nomic-embed-text` and the same 768 dimensions, so the collection stays valid in
shape — but "same family" is not "same vectors", and a re-seed costs one command
against a 48-chunk corpus.
"""
import logging
from functools import lru_cache

# pyrefly: ignore [missing-import]
from langchain_core.embeddings import Embeddings

from src.config.settings import settings

logger = logging.getLogger(__name__)


class _DimensionChecked(Embeddings):
    """
    Wraps an embedder and fails loudly the first time its output size is wrong.

    EMBED_DIMENSION is what the Qdrant collection was created with. If the model
    returns a different width, Qdrant rejects the write — but only at seed time,
    and only for writes. A *query* of the wrong width against a collection built
    at another width is the failure with no symptom: it either errors deep in the
    client or returns whatever was nearest in a space the query does not belong
    to. Checking once, here, turns that into a sentence naming both numbers.
    """

    def __init__(self, inner: Embeddings, expected: int, name: str) -> None:
        self._inner = inner
        self._expected = expected
        self._name = name
        self._checked = False

    def _verify(self, vectors: list[list[float]]) -> list[list[float]]:
        if not self._checked and vectors:
            actual = len(vectors[0])
            self._checked = True
            if actual != self._expected:
                raise RuntimeError(
                    f"embedding model '{self._name}' returned {actual}-dimensional "
                    f"vectors but EMBED_DIMENSION is {self._expected}. Set "
                    f"EMBED_DIMENSION={actual} and re-seed with --recreate; the "
                    f"existing collection cannot be queried with these vectors."
                )
            logger.info(f"embedding dimension confirmed: {actual}")
        return vectors

    def embed_documents(self, texts: list[str]) -> list[list[float]]:
        return self._verify(self._inner.embed_documents(texts))

    def embed_query(self, text: str) -> list[float]:
        return self._verify([self._inner.embed_query(text)])[0]


@lru_cache(maxsize=1)
def get_embeddings() -> Embeddings:
    if settings.MODEL_PROVIDER.strip().lower() in ("api", "openrouter"):
        # pyrefly: ignore [missing-import]
        from langchain_openai import OpenAIEmbeddings

        if not settings.API_KEY:
            raise RuntimeError(
                "MODEL_PROVIDER=api but API_KEY is not set"
            )

        logger.info(
            f"Loading embeddings via API: model={settings.API_EMBED_MODEL}"
        )
        # `dimensions=` is deliberately NOT sent. It is an OpenAI extension for
        # Matryoshka truncation and models that do not implement it reject the
        # request outright, which would turn every embedding call into an error.
        # The guarantee it was there to provide — that the vectors match the
        # collection — is kept by _DimensionChecked below, which verifies what
        # the model actually returned rather than asking for a size and hoping.
        return _DimensionChecked(
            OpenAIEmbeddings(
                base_url=settings.API_BASE_URL,
                api_key=settings.API_KEY,
                model=settings.API_EMBED_MODEL,
                check_embedding_ctx_length=False,   # not an OpenAI tokenizer
                # langchain requests base64 vectors by default, which is smaller
                # on the wire and which NVIDIA's embeddings endpoint rejects
                # outright: "Nvidia embeddings do not support base64
                # encoding_format." Asking for floats costs bandwidth we do not
                # notice on a 48-chunk corpus.
                model_kwargs={"encoding_format": "float"},
            ),
            expected=settings.EMBED_DIMENSION,
            name=settings.API_EMBED_MODEL,
        )

    # pyrefly: ignore [missing-import]
    from langchain_ollama import OllamaEmbeddings

    logger.info(
        f"Loading embeddings via Ollama: model={settings.EMBED_MODEL} "
        f"base_url={settings.LLM_BASE_URL}"
    )
    return OllamaEmbeddings(
        base_url=settings.LLM_BASE_URL,
        model=settings.EMBED_MODEL,
    )

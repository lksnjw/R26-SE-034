#pyrefly: ignore [missing-import]
from pydantic import AliasChoices, Field

#pyrefly: ignore [missing-import]
from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    # ── Model backend ────────────────────────────────────────────────────────
    # Two backends behind one interface, selected by MODEL_PROVIDER:
    #
    #   "ollama"     local development. The default, so nothing here changes for
    #                anyone running it on their own machine.
    #   "openrouter" any OpenAI-compatible endpoint. What a hosted deployment
    #                uses, because a 3B model on a CPU instance takes ~23s for a
    #                single judge pass — not a latency you can serve.
    #
    # The two are kept switchable rather than swapped outright: the local path is
    # what the golden cases run against, and losing the ability to run them
    # offline would mean the suite only ever passes when a paid API is reachable.
    # "api" covers every OpenAI-compatible endpoint — OpenRouter, Google Gemini,
    # Groq, vLLM — because they differ only in base URL and model names. The
    # value "openrouter" is still accepted so existing .env files keep working.
    MODEL_PROVIDER: str = "ollama"           # ollama | api

    LLM_BASE_URL: str = "http://localhost:11434"           # ollama

    # Named for the protocol, not the vendor. These pointed at OpenRouter, then
    # at Google; a setting called OPENROUTER_BASE_URL holding a Google URL is the
    # kind of thing that is still lying to someone six months from now.
    API_BASE_URL: str = Field(
        "https://openrouter.ai/api/v1",
        validation_alias=AliasChoices("API_BASE_URL", "OPENROUTER_BASE_URL"),
    )
    API_KEY: str | None = Field(
        None, validation_alias=AliasChoices("API_KEY", "OPENROUTER_API_KEY")
    )
    LLM_MODEL: str = "llama3"
    # Reasoning models spend tokens thinking before they emit the JSON, so the
    # local budgets are too tight for them. A truncated reply raises
    # LengthFinishReasonError, which the gate reports as "judge unavailable" and
    # denies — a permitted request refused because the model ran out of room.
    API_TOKEN_FACTOR: int = Field(
        8, validation_alias=AliasChoices("API_TOKEN_FACTOR", "OPENROUTER_TOKEN_FACTOR")
    )
    # Free tiers rate-limit hard, and a 429 reaches the gate as a denial — a test
    # failure that reads as a logic bug. The limits that bite are per-MINUTE
    # (Gemini Flash-Lite allows 15), so the backoff has to be able to wait out a
    # whole window: the client doubles its delay each attempt, and 8 retries is
    # the first value that exceeds 60s in total.
    API_MAX_RETRIES: int = Field(
        8, validation_alias=AliasChoices("API_MAX_RETRIES", "OPENROUTER_MAX_RETRIES")
    )

    # ── Embeddings ───────────────────────────────────────────────────────────
    # EMBED_DIMENSION must match whatever EMBED_MODEL emits, and both must match
    # the vectors already in Qdrant. Changing the model puts queries in a
    # different vector space from the index: no error, no warning, just
    # similarity scores that are noise. Re-seed after any change here.
    EMBED_MODEL: str = "nomic-embed-text"                  # ollama name, 768-d
    # Each provider serves a different embedding model at a different width, and
    # a Qdrant collection is fixed at the width it was created with. Set
    # EMBED_DIMENSION to match *before* seeding, then --recreate.
    #   ollama  nomic-embed-text                 768
    #   gemini  gemini-embedding-001            3072 (default)
    #   openrouter nvidia/nemotron-3-embed-1b:free 2048
    API_EMBED_MODEL: str = Field(
        "gemini-embedding-001",
        validation_alias=AliasChoices("API_EMBED_MODEL", "OPENROUTER_EMBED_MODEL"),
    )
    EMBED_DIMENSION: int = 768      # must match the embedding model output size


    # Qdrant
    QDRANT_URL: str = "http://localhost:6333"
    QDRANT_COLLECTION: str = "rag_docs"
    QDRANT_API_KEY: str | None = None
    # Seconds. The client default (~5s) is too tight for a hosted cluster —
    # a timed-out read fails the decision closed, so it must not happen routinely.
    QDRANT_TIMEOUT: int = 60

    # Baseline splitter settings. Nothing in the gate uses these — they exist so
    # `scripts.verify_policy_chunking` can reproduce what a general character-window
    # splitter does to a policy clause, which is the comparison that justifies the
    # clause-aware chunker.
    CHUNK_SIZE: int = 500
    CHUNK_OVERLAP: int = 50

    # Policy gate
    POLICY_COLLECTION: str = "policy_docs"   # kept separate from QDRANT_COLLECTION
    POLICY_TOP_K: int = 20                   # recall over precision — missing a rule allows it
    POLICY_CHUNK_SIZE: int = 1200            # large enough to keep a whole rule intact
    POLICY_CHUNK_OVERLAP: int = 200
    JUDGE_MODEL: str = "llama3.1:8b"         # deliberately larger than LLM_MODEL
    POLICY_FAIL_CLOSED: bool = True          # judge error/timeout ⇒ DENY, never allow

    # ── Assist (read-tool planner) ──────────────────────────────────────────
    # Independent from LLM_MODEL the same way JUDGE_MODEL is, so tool-selection
    # accuracy can be tuned separately once real tool shapes exist. Empty means
    # "use LLM_MODEL" — a fresh .env with no ASSIST_MODEL still starts correctly,
    # unlike JUDGE_MODEL, which hardcodes its own default independently.
    ASSIST_MODEL: str = ""

    @property
    def assist_model(self) -> str:
        return self.ASSIST_MODEL.strip() or self.LLM_MODEL

    # No tool-provider settings: this service returns a decision, it does not
    # execute. The caller holds the MCP/ERP credentials.

    # ── Serving ──────────────────────────────────────────────────────────────
    # Container platforms (Azure Container Apps, Railway, Cloud Run) inject the
    # port to listen on. Hardcoding 8000 makes the container start and then be
    # unreachable, which presents as a health-check failure with a healthy log.
    PORT: int = 8000

    # ── Inbound access control ───────────────────────────────────────────────
    # See src/api/security.py. Comma-separated; empty disables the check, which
    # is right for localhost and wrong for anything with a public address.
    API_KEYS: str = ""
    # Comma-separated allowed origins. "*" suits local development; narrow it to
    # the calling application's origin once deployed.
    CORS_ORIGINS: str = "*"
    # The demo page holds a key in the browser in order to call the API, so it
    # hands that key to anyone who can load the page. Off wherever that matters.
    ENABLE_DEMO: bool = True

    @property
    def api_keys(self) -> set[str]:
        return {k.strip() for k in self.API_KEYS.split(",") if k.strip()}

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.CORS_ORIGINS.split(",") if o.strip()] or ["*"]

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


# Convenience singleton — import `settings` anywhere
settings: Settings = get_settings()

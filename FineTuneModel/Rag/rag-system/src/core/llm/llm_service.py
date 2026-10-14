"""
LLM service — the only place the chat backend is chosen.

Two providers behind one interface, selected by `MODEL_PROVIDER`:

  ollama   local development, no key required. The default, and what the golden
           cases run against.
  api      any OpenAI-compatible endpoint — Google Gemini, Groq, OpenRouter,
           vLLM. They differ only in base URL and model names, so one branch
           covers all of them; "openrouter" is still accepted as a value.

Both are kept rather than one replacing the other. The suite has to be runnable
offline: a test set that only passes when a paid API is reachable stops being run,
and this one is the reason several silent failures were caught at all.

WHAT MUST HOLD FOR EITHER PROVIDER
  - JSON-only output. Every caller parses the reply as JSON, and a model writing
    prose produced parse errors that surfaced as denials — indistinguishable from
    principled ones, which is how an inbound receipt read as an outbound payment
    stayed hidden for a while.
  - temperature 0 for the judge. A compliance verdict that varies between two
    identical requests cannot be defended in an audit.
"""
import logging
from functools import lru_cache

# pyrefly: ignore [missing-import]
from langchain_core.language_models import BaseChatModel

from src.config.settings import settings

logger = logging.getLogger(__name__)


def _is_api() -> bool:
    return settings.MODEL_PROVIDER.strip().lower() in ("api", "openrouter")


def _chat_model(model: str, temperature: float, max_tokens: int) -> BaseChatModel:
    """Build a JSON-constrained chat model from whichever provider is configured."""
    if _is_api():
        # pyrefly: ignore [missing-import]
        from langchain_openai import ChatOpenAI

        if not settings.API_KEY:
            # Failing here is better than failing per-request: an unauthenticated
            # provider makes every call raise, and every raised call is a denial.
            raise RuntimeError(
                "MODEL_PROVIDER=api but API_KEY is not set"
            )

        logger.info(f"Loading LLM via API: model={model}")
        return ChatOpenAI(
            base_url=settings.API_BASE_URL,
            api_key=settings.API_KEY,
            model=model,
            temperature=temperature,
            # Deliberately more generous than the Ollama budget. A reasoning
            # model spends tokens before it emits the JSON, and a reply cut off
            # mid-object raises LengthFinishReasonError — which reaches the gate
            # as "judge unavailable" and denies a request that was permitted.
            # Truncation is indistinguishable from a policy refusal downstream,
            # so the limit has to be set where it cannot be reached.
            max_tokens=max_tokens * settings.API_TOKEN_FACTOR,
            # Free-tier endpoints rate-limit aggressively and the golden suite
            # fires ~50 calls back to back. Without backoff a 429 surfaces as a
            # denial, which is a test failure that looks like a logic bug.
            max_retries=settings.API_MAX_RETRIES,
            # The OpenAI-compatible equivalent of Ollama's format="json".
            model_kwargs={"response_format": {"type": "json_object"}},
        )

    # pyrefly: ignore [missing-import]
    from langchain_ollama import ChatOllama

    logger.info(f"Loading LLM via Ollama: model={model} base_url={settings.LLM_BASE_URL}")
    return ChatOllama(
        base_url=settings.LLM_BASE_URL,
        model=model,
        temperature=temperature,
        num_predict=max_tokens,
        format="json",
    )


@lru_cache(maxsize=1)
def get_llm() -> BaseChatModel:
    """The extraction/classification model. Low temperature, not zero."""
    return _chat_model(settings.LLM_MODEL, temperature=0.1, max_tokens=1024)


@lru_cache(maxsize=1)
def get_judge_llm() -> BaseChatModel:
    """
    The model used for policy judgement.

    Separate from `get_llm()` on purpose: JUDGE_MODEL is deliberately larger than
    LLM_MODEL, and temperature is pinned to 0.
    """
    return _chat_model(settings.JUDGE_MODEL, temperature=0.0, max_tokens=768)


@lru_cache(maxsize=1)
def get_assist_llm() -> BaseChatModel:
    """
    The read-tool planner model for /api/assist.

    Temperature 0, same rationale as the judge: a plan or grounded answer that
    varies between two identical calls is not something a caller can build a
    reliable agent loop against.
    """
    return _chat_model(settings.assist_model, temperature=0.0, max_tokens=1024)

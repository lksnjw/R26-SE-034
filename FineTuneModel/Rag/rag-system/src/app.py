"""
app.py — FastAPI application entry point.

Startup sequence:
  1. Load settings from .env
  2. Report the policy-gate configuration
  3. Start accepting requests

The corpus is not loaded here — see `python -m scripts.seed_qdrant_policies`.
"""
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse

from mcp.server.transport_security import TransportSecuritySettings

from src.api.mcp_server import mcp
from src.api.routes.assist_routes import router as assist_router
from src.api.routes.policy_routes import router as policy_router
from src.api.security import key_is_valid, require_api_key
from src.config.settings import settings

# Built once, at import, and before the lifespan runs. `mcp.session_manager` is
# created lazily *inside* this call — reading it first raises. So the ASGI app
# has to exist before anything can enter its session manager.
#
# The app serves /mcp internally and is mounted at "/" below — the SDK's own
# pattern. Mounting it at "/mcp" instead nests the route to /mcp/mcp, and a
# client pointed at /mcp gets a 307 to /mcp/ which it does not follow on POST,
# surfacing as "Unexpected content type:" with no further explanation.
#
# DNS-rebinding protection off. It validates the Host header against a list, has
# no wildcard, and defaults to localhost only — sound for a local server a
# browser might reach, unworkable here: behind Azure Container Apps every
# request arrives with a platform hostname not known at build time, and each one
# would be refused with 421. What guards this endpoint is the API key, checked
# by the middleware below before the mount is reached.
_MCP_APP = mcp.streamable_http_app(
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=False,
        allowed_hosts=[],
        allowed_origins=[],
    ),
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  [%(levelname)-8s]  %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Run startup tasks before the server accepts requests."""
    # Report the embedding model actually in use, not the Ollama one. The log
    # said `embed=nomic-embed-text` while the app was calling Gemini, which is
    # the one line an operator reads to confirm what the container is doing.
    on_api = settings.MODEL_PROVIDER.strip().lower() in ("api", "openrouter")
    logger.info(
        f"Starting policy gate | provider={settings.MODEL_PROVIDER} "
        f"| llm={settings.LLM_MODEL} | judge={settings.JUDGE_MODEL} "
        f"| embed={settings.API_EMBED_MODEL if on_api else settings.EMBED_MODEL}"
        f"@{settings.EMBED_DIMENSION}d"
    )
    logger.info(
        f"Policy collection={settings.POLICY_COLLECTION} "
        f"| fail_closed={settings.POLICY_FAIL_CLOSED} "
        f"| auth={'on' if settings.api_keys else 'OFF'} "
        f"| demo={'on' if settings.ENABLE_DEMO else 'off'}"
    )
    if not settings.api_keys:
        logger.warning(
            "No API_KEYS set: any caller may choose their own actor.role, and "
            "every policy control is decided on that choice."
        )

    # The corpus is loaded by `python -m scripts.seed_qdrant_policies`, not here.
    # Seeding on boot re-ingested its source file into the collection on every
    # restart, and an unbounded pile of duplicate chunks in a collection the gate
    # reads from is not something a policy decision should be exposed to.

    # Mounting an MCP app disables its own lifespan, so its session manager has
    # to be started by whoever mounted it. Without this the mount looks correct,
    # the server starts cleanly, and the first MCP request fails.
    async with mcp.session_manager.run():
        logger.info("MCP server mounted at /mcp | tool: check_policy")
        yield  # ← server is live here

    logger.info("Policy gate shutting down — goodbye!")


# ── FastAPI app ───────────────────────────────────────────────────────────────

app = FastAPI(
    title="ERP Finance Policy Gate",
    description=(
        "Decides whether a natural-language finance request is permitted under "
        "company policy, and returns what the caller needs to execute it.\n\n"
        "**Pipeline:** `prompt → intent → retrieve rules → deterministic checks "
        "→ judge → verdict`\n\n"
        "This service does not execute anything. `POST /api/policy/evaluate` "
        "returns a decision, the proposed action, the clauses it rests on, and "
        "any conditions the caller must satisfy first. `POST /api/assist` is its "
        "read-only sibling: it plans which of the caller's own read-only tools "
        "to call, or answers from results already shown to it — see "
        "docs/ASSIST_CONTRACT.md."
    ),
    version="2.1.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# The key check guards the decision API only. /health stays open so a platform
# health probe does not need a credential, and it deliberately exposes no policy
# data — only whether the store and the model backend are reachable.
app.include_router(policy_router, dependencies=[Depends(require_api_key)])
app.include_router(assist_router, dependencies=[Depends(require_api_key)])


# ── MCP surface ───────────────────────────────────────────────────────────────

@app.middleware("http")
async def guard_mcp(request, call_next):
    """
    Apply the API-key check to the mounted MCP app.

    A mounted ASGI app is dispatched before FastAPI's routing, so the
    `dependencies=[Depends(require_api_key)]` above never runs for it. Left
    alone, /mcp would be the unauthenticated way into an authenticated service —
    the same decision endpoint, reachable by anyone, exposed by the convenience
    wrapper rather than by the API it wraps.
    """
    if request.url.path.startswith("/mcp") and not key_is_valid(
        request.headers.get("x-api-key")
    ):
        return JSONResponse(
            status_code=401,
            content={"detail": "A valid X-API-Key header is required."},
            headers={"WWW-Authenticate": "ApiKey"},
        )
    return await call_next(request)


# The mount itself is registered at the BOTTOM of this file — see the note there.


# ── Demo page ─────────────────────────────────────────────────────────────────

_DEMO_PAGE = Path(__file__).parent / "static" / "demo.html"
# Substituted into the page so the browser can call an authenticated API. This is
# why ENABLE_DEMO exists: the page hands this key to whoever loads it, so serving
# it publicly publishes a working credential.
_DEMO_KEY_PLACEHOLDER = "__DEMO_API_KEY__"


@app.get("/demo", tags=["System"], summary="Demo UI", include_in_schema=False)
def demo():
    """
    A single static page for demonstrating the gate by hand.

    Served from this app rather than opened as a file so it shares an origin with
    the API: a `file://` page is treated as a null origin, which CORS cannot
    whitelist. It is a demo surface, not part of the published contract.
    """
    if not settings.ENABLE_DEMO:
        raise HTTPException(status_code=404, detail="Not found")

    html = _DEMO_PAGE.read_text(encoding="utf-8")
    key = next(iter(sorted(settings.api_keys)), "")
    return HTMLResponse(html.replace(_DEMO_KEY_PLACEHOLDER, key))


# ── Health endpoint ───────────────────────────────────────────────────────────

@app.get("/health", tags=["System"], summary="Health check")
def health():
    """
    Current configuration and policy-corpus size.

    Reports the policy collection specifically: the gate is only as good as the
    rules it can see, and a collection that is reachable but empty would
    otherwise look identical to a healthy one.
    """
    from src.core.policy.policy_retriever import get_policy_retriever

    try:
        chunks = get_policy_retriever().corpus_size()
        store = "ok" if chunks else "empty"
    except Exception as exc:  # noqa: BLE001 — health must report, not raise
        chunks, store = 0, f"unreachable: {type(exc).__name__}"

    openrouter = settings.MODEL_PROVIDER.strip().lower() in ("api", "openrouter")

    return {
        "status": "ok" if store == "ok" else "degraded",
        "policy_store": store,
        "policy_collection": settings.POLICY_COLLECTION,
        "policy_chunks": chunks,
        # Which backend is actually live. A deployment configured for OpenRouter
        # with no key still starts, and every request then denies on a failed
        # model call — a failure that reads as strict policy rather than as
        # missing configuration, so it is reported here instead.
        "model_provider": settings.MODEL_PROVIDER,
        "model_credentials": (
            "missing" if openrouter and not settings.API_KEY else "ok"
        ),
        "llm_model": settings.LLM_MODEL,
        "judge_model": settings.JUDGE_MODEL,
        "embed_model": (
            settings.API_EMBED_MODEL if openrouter else settings.EMBED_MODEL
        ),
        "embed_dimension": settings.EMBED_DIMENSION,
        "fail_closed": settings.POLICY_FAIL_CLOSED,
        "mcp": "/mcp",
    }


# ── MCP mount — must stay LAST in this file ───────────────────────────────────
#
# The MCP app carries its own /mcp route and is mounted at the root, so it
# matches any path. Starlette resolves routes in registration order, which makes
# position load-bearing: mounted above, it swallowed /demo and /health and both
# started returning 404 while /docs and /api/policy/* — registered earlier —
# kept working. Anything declared below this line is unreachable.
app.mount("/", _MCP_APP)

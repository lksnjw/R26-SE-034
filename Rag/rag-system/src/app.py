"""Employee registration policy gate. This service never executes ERP writes."""
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from mcp.server.transport_security import TransportSecuritySettings

from src.api.mcp_server import mcp
from src.api.routes.policy_routes import router
from src.api.security import key_is_valid, require_api_key
from src.config.qdrant_client import get_qdrant_client
from src.config.settings import settings
from src.core.registration.corpus import FLOW, load_corpus
from src.core.registration.retriever import policy_filter

_MCP_APP = mcp.streamable_http_app(transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False, allowed_hosts=[], allowed_origins=[]))


@asynccontextmanager
async def lifespan(app):
    async with mcp.session_manager.run():
        yield


app = FastAPI(title="Sri Lanka Employee Registration Policy Gate", version="3.0.0", lifespan=lifespan,
              description="Validate employee form data against EMP-REG-001 through EMP-REG-011. Returns ALLOW, BLOCK or ESCALATE. Only the authenticated ERP backend may call this API; it must enforce ALLOW before creating an account.")
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_methods=["*"], allow_headers=["*"])
app.include_router(router, dependencies=[Depends(require_api_key)])


@app.middleware("http")
async def guard_mcp(request, call_next):
    if request.url.path.startswith("/mcp"):
        if not settings.api_keys:
            return JSONResponse(status_code=503, content={"detail": "Configure API_KEYS for the trusted ERP backend."})
        if not key_is_valid(request.headers.get("x-api-key")):
            return JSONResponse(status_code=401, content={"detail": "A valid X-API-Key header is required."})
    return await call_next(request)


@app.get("/health")
def health():
    try:
        count = get_qdrant_client().count(settings.POLICY_COLLECTION, count_filter=policy_filter(), exact=True).count
        store = "ok" if count == len(load_corpus()) else "incomplete"
    except Exception:
        count, store = 0, "unreachable"
    return {"status": "ok" if store == "ok" and settings.api_keys else "degraded", "flow": FLOW,
            "policy_collection": settings.POLICY_COLLECTION, "policy_chunks": count, "policy_store": store,
            "backend_auth_configured": bool(settings.api_keys)}


app.mount("/", _MCP_APP)

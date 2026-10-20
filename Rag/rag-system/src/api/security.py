"""Authenticate the trusted ERP backend that supplies verified requester facts."""
import hmac

from fastapi import HTTPException, Security
from fastapi.security import APIKeyHeader

from src.config.settings import settings

backend_key = APIKeyHeader(name="X-API-Key", scheme_name="BackendApiKey", auto_error=False,
                          description="Shared backend credential. Never expose it in a frontend or model prompt.")


def key_is_valid(presented: str | None) -> bool:
    return bool(presented) and any(hmac.compare_digest(presented, key) for key in settings.api_keys)


async def require_api_key(x_api_key: str | None = Security(backend_key)) -> None:
    if not settings.api_keys:
        raise HTTPException(503, "Configure API_KEYS for the trusted ERP backend before validating registration.")
    if not key_is_valid(x_api_key):
        raise HTTPException(401, "A valid X-API-Key header is required.", headers={"WWW-Authenticate": "ApiKey"})

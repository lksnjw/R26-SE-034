"""
Inbound access control for the policy API.

WHY THIS EXISTS

`actor.role` is trusted completely and cannot be verified here — the gateway
contract says it must come from the caller's authenticated session, and this
service has no way to check that claim. Locally that is fine; the only caller is
the developer. On a public address it is not: without a key, anyone can send

    {"prompt": "release payment for INV-8842",
     "actor": {"user_id": "x", "role": "finance_manager", "is_document_owner": false},
     "context": {"amount": 999999}}

and be told the payment is permitted. Every control in this system — thresholds,
roles, segregation of duties — is enforced against a role string the sender
chose. The key is what makes that string mean something: it says the request
came from the ERP middleware, which *did* authenticate someone.

FAILURE POSTURE

Off by default, because a key check that blocks local development gets disabled
and never re-enabled. But `/health` reports whether it is on, so a deployment
that forgot to set API_KEYS is visible without having to guess.
"""
import hmac
import logging

from fastapi import Header, HTTPException, status

from src.config.settings import settings

logger = logging.getLogger(__name__)

_warned = False


def key_is_valid(presented: str | None) -> bool:
    """
    Is this a valid key — or is the check switched off entirely?

    The single place the comparison happens. Two entry points need it: the
    FastAPI dependency below, and the middleware guarding the mounted MCP app
    (a mounted ASGI app never sees router dependencies). Two copies of an auth
    check is one copy that gets fixed and one that does not.

    Compared with `hmac.compare_digest` rather than `==`. String comparison
    returns as soon as two characters differ, so the time it takes leaks how
    much of the key was right — enough, over many requests, to recover it one
    character at a time.
    """
    global _warned

    keys = settings.api_keys
    if not keys:
        if not _warned:
            _warned = True
            logger.warning(
                "API_KEYS is empty — the policy API is unauthenticated. Fine on "
                "localhost; on a public address it means the caller chooses their "
                "own role, and every policy control is decided on that choice."
            )
        return True

    return bool(presented) and any(hmac.compare_digest(presented, k) for k in keys)


async def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    """FastAPI dependency: reject a request that carries no valid `X-API-Key`."""
    if not key_is_valid(x_api_key):
        # 401 rather than 403: the caller may retry *with* credentials. Deliberately
        # says nothing about whether the key was absent, malformed, or simply wrong.
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="A valid X-API-Key header is required.",
            headers={"WWW-Authenticate": "ApiKey"},
        )

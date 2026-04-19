from __future__ import annotations

from fastapi import Header, HTTPException, status

from app.core.config import settings


async def require_access(authorization: str | None = Header(default=None)) -> None:
    """Standalone Bearer-token auth dependency.

    When `settings.email_extractor_api_key` is unset, every request is allowed
    (dev mode). When set, the request must carry `Authorization: Bearer <key>`
    matching it exactly.

    On merge into fis-lead-gen, replace this body with a call into
    services/auth.py and swap Depends(...) target to the BetterAuth session
    dependency.
    """
    expected = settings.email_extractor_api_key
    if not expected:
        return

    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or malformed Authorization header",
            headers={"WWW-Authenticate": "Bearer"},
        )

    provided = authorization.split(" ", 1)[1].strip()
    if provided != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key",
            headers={"WWW-Authenticate": "Bearer"},
        )

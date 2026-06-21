"""BetterAuth session validation for the standalone email-extractor.

The frontend runs BetterAuth (email + password) and writes the session into the
shared ``session`` table, setting a signed ``better-auth.session_token`` cookie.
This module validates that cookie on each backend request: verify the HMAC
signature with ``settings.auth_secret``, look the token up in ``session``, and
return the resolved :class:`AuthenticatedUser`.

(The DOX parent also carried a Cloud-Scheduler OIDC dual-path here; the
standalone has no scheduler jobs, so only the cookie path is ported.)
"""

from __future__ import annotations

import base64
import hashlib
import hmac
from datetime import UTC, datetime
from urllib.parse import unquote

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.db.session import get_db_session
from app.models.auth import AuthSession
from app.schemas.auth import AuthenticatedUser


def _decode_signed_session_cookie(raw_cookie_value: str | None) -> str | None:
    """Verify and strip BetterAuth's HMAC signature, returning the bare token.

    BetterAuth signs the cookie as ``<token>.<base64(hmac_sha256(token))>``. A
    value without a separator is treated as already-bare (returned as-is); a
    present-but-wrong signature returns ``None`` (reject)."""
    if not raw_cookie_value:
        return None

    decoded_value = unquote(raw_cookie_value)
    token, separator, signature = decoded_value.rpartition(".")
    if not separator or not token or not signature:
        return raw_cookie_value

    expected_signature = base64.b64encode(
        hmac.new(settings.auth_secret.encode("utf-8"), token.encode("utf-8"), hashlib.sha256).digest()
    ).decode("utf-8")

    if not hmac.compare_digest(signature, expected_signature):
        return None

    return token


async def get_current_user(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
) -> AuthenticatedUser:
    session_token = _decode_signed_session_cookie(request.cookies.get(settings.auth_session_cookie_name))
    if not session_token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")

    stmt = (
        select(AuthSession)
        .options(selectinload(AuthSession.user))
        .where(AuthSession.token == session_token)
        .where(AuthSession.expires_at > datetime.now(UTC))
    )

    try:
        result = await db.execute(stmt)
    except ProgrammingError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication tables are unavailable. Run migrations before using auth-protected routes.",
        ) from exc

    auth_session = result.scalar_one_or_none()
    if auth_session is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session is invalid or expired.")

    # Bump last_activity_at, gated to ~60s so read-heavy bursts don't write on
    # every request. Cheap freshness signal for any "recently active" UI.
    now = datetime.now(UTC)
    last_seen = auth_session.last_activity_at
    if last_seen is None or (now - last_seen).total_seconds() > 60:
        auth_session.last_activity_at = now
        await db.commit()

    return AuthenticatedUser(
        id=auth_session.user.id,
        name=auth_session.user.name,
        email=auth_session.user.email,
        role=auth_session.user.role,
        feature_permissions=list(auth_session.user.feature_permissions or []),
        session_expires_at=auth_session.expires_at,
    )


def ensure_feature(user: AuthenticatedUser, feature_key: str) -> None:
    """Gate a feature for non-admins. Admins bypass every gate."""
    if user.role == "admin":
        return
    if feature_key not in user.feature_permissions:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Feature access not granted.",
        )

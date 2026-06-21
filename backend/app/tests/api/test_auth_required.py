"""The email-extractor endpoints must reject unauthenticated callers.

Each test pops the conftest auto-auth override so the real BetterAuth session
dependency runs -- with no session cookie, every gated route is a 401. The
no-cookie path short-circuits before any DB query, so these stay in the default
(non-integration) suite.
"""

from __future__ import annotations

import httpx

from app.main import app
from app.services.auth import get_current_user


def _client() -> httpx.AsyncClient:
    transport = httpx.ASGITransport(app=app)
    return httpx.AsyncClient(transport=transport, base_url="http://testserver")


async def test_create_scan_requires_auth() -> None:
    app.dependency_overrides.pop(get_current_user, None)
    async with _client() as client:
        resp = await client.post("/api/v1/email-extractor/scans", json={"domain": "example.com"})
    assert resp.status_code == 401


async def test_get_scan_requires_auth() -> None:
    app.dependency_overrides.pop(get_current_user, None)
    async with _client() as client:
        resp = await client.get("/api/v1/email-extractor/scans/1")
    assert resp.status_code == 401


async def test_list_scans_requires_auth() -> None:
    app.dependency_overrides.pop(get_current_user, None)
    async with _client() as client:
        resp = await client.get("/api/v1/email-extractor/scans")
    assert resp.status_code == 401


async def test_enrich_requires_auth() -> None:
    app.dependency_overrides.pop(get_current_user, None)
    async with _client() as client:
        resp = await client.post("/api/v1/email-extractor/discovered-emails/1/enrich")
    assert resp.status_code == 401


async def test_webhook_is_not_session_gated() -> None:
    """The Apollo webhook authenticates via its path secret, not a session, so a
    missing session cookie must NOT 401 it. With no secret configured it returns
    503 (not configured) -- proving it reached the handler, not the auth gate."""
    app.dependency_overrides.pop(get_current_user, None)
    async with _client() as client:
        resp = await client.post("/api/v1/webhooks/apollo/whatever/phone-reveal", json={"people": []})
    assert resp.status_code != 401

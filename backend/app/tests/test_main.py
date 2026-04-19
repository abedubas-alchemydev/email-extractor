"""Smoke tests for the FastAPI scaffold.

The respx-based test seeds the pattern future provider tests (Hunter/Apollo/Snov)
will use to mock outbound HTTP — keeps respx exercised so it doesn't rot in
requirements-dev.txt while we wait for the first real provider.
"""

from __future__ import annotations

import httpx
import respx

from app.main import app


async def test_root_health_returns_ok() -> None:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_v1_health_returns_ok() -> None:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        response = await client.get("/api/v1/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@respx.mock
async def test_respx_mocks_external_call() -> None:
    """Pattern-seeding test: future provider modules will use this exact shape
    to mock Hunter/Apollo/Snov endpoints in their unit tests."""
    route = respx.get("https://example.test/discover").mock(
        return_value=httpx.Response(200, json={"emails": ["test@example.test"]})
    )

    async with httpx.AsyncClient() as client:
        response = await client.get("https://example.test/discover")

    assert route.called
    assert response.status_code == 200
    assert response.json() == {"emails": ["test@example.test"]}

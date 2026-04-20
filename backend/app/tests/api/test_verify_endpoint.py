"""Endpoint tests for POST /api/v1/email-extractor/verify.

Marked as ``integration`` because the handler reads ``DiscoveredEmail`` rows
and writes ``EmailVerification`` rows through the real DB session — same
pattern as ``test_email_extractor_scans.py``. The SMTP probe itself is fully
mocked at the endpoint module's ``check_smtp`` import site, so no network I/O
to real MTAs.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable

import httpx
import pytest
from sqlalchemy import select

from app.api.v1.endpoints import email_extractor as endpoint_module
from app.core import config
from app.db.session import SessionLocal
from app.main import app
from app.models.discovered_email import DiscoveredEmail
from app.models.email_verification import EmailVerification, SmtpStatus
from app.models.extraction_run import ExtractionRun, RunStatus

pytestmark = pytest.mark.integration


SmtpFn = Callable[[str], Awaitable[tuple[SmtpStatus, str | None]]]


async def _seed_emails(count: int, domain: str = "example.com") -> list[int]:
    """Insert one ExtractionRun + ``count`` DiscoveredEmail rows; return IDs."""
    async with SessionLocal() as session:
        run = ExtractionRun(domain=domain, status=RunStatus.completed.value)
        session.add(run)
        await session.flush()
        emails = [
            DiscoveredEmail(
                run_id=run.id,
                email=f"u{i}@{domain}",
                domain=domain,
                source="test",
                confidence=0.5,
            )
            for i in range(count)
        ]
        session.add_all(emails)
        await session.commit()
        return [e.id for e in emails]


def _patch_check_smtp(monkeypatch: pytest.MonkeyPatch, fake: SmtpFn) -> None:
    monkeypatch.setattr(endpoint_module, "check_smtp", fake)


async def _post_verify(payload: dict[str, object]) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        return await client.post("/api/v1/email-extractor/verify", json=payload)


# --- Happy paths -----------------------------------------------------------


async def test_verify_happy_path_all_deliverable(monkeypatch: pytest.MonkeyPatch) -> None:
    email_ids = await _seed_emails(3)

    async def fake(_email: str) -> tuple[SmtpStatus, str | None]:
        return SmtpStatus.deliverable, None

    _patch_check_smtp(monkeypatch, fake)

    response = await _post_verify({"email_ids": email_ids})

    assert response.status_code == 200
    body = response.json()
    assert len(body["results"]) == 3
    for item in body["results"]:
        assert item["smtp_status"] == "deliverable"
        assert item["smtp_message"] is None
        assert item["email"] is not None
        assert item["checked_at"] is not None

    async with SessionLocal() as session:
        rows = (
            (
                await session.execute(
                    select(EmailVerification).where(EmailVerification.discovered_email_id.in_(email_ids))
                )
            )
            .scalars()
            .all()
        )
        assert len(rows) == 3
        assert all(r.smtp_status == "deliverable" for r in rows)


async def test_verify_preserves_input_order(monkeypatch: pytest.MonkeyPatch) -> None:
    email_ids = await _seed_emails(3)
    reordered = [email_ids[2], email_ids[0], email_ids[1]]

    async def fake(_email: str) -> tuple[SmtpStatus, str | None]:
        return SmtpStatus.deliverable, None

    _patch_check_smtp(monkeypatch, fake)

    response = await _post_verify({"email_ids": reordered})

    assert response.status_code == 200
    returned_ids = [item["email_id"] for item in response.json()["results"]]
    assert returned_ids == reordered


async def test_verify_inconclusive_round_trip(monkeypatch: pytest.MonkeyPatch) -> None:
    email_ids = await _seed_emails(1)

    async def fake(_email: str) -> tuple[SmtpStatus, str | None]:
        return SmtpStatus.inconclusive, None

    _patch_check_smtp(monkeypatch, fake)

    response = await _post_verify({"email_ids": email_ids})

    assert response.status_code == 200
    item = response.json()["results"][0]
    assert item["smtp_status"] == "inconclusive"

    async with SessionLocal() as session:
        row = (
            (
                await session.execute(
                    select(EmailVerification).where(EmailVerification.discovered_email_id == email_ids[0])
                )
            )
            .scalars()
            .one()
        )
        assert row.smtp_status == "inconclusive"


# --- Edge cases ------------------------------------------------------------


async def test_verify_unknown_id_returns_stub_item(monkeypatch: pytest.MonkeyPatch) -> None:
    email_ids = await _seed_emails(1)
    unknown_id = 99_999_999

    async def fake(_email: str) -> tuple[SmtpStatus, str | None]:
        return SmtpStatus.deliverable, None

    _patch_check_smtp(monkeypatch, fake)

    response = await _post_verify({"email_ids": [email_ids[0], unknown_id]})

    assert response.status_code == 200
    body = response.json()
    assert len(body["results"]) == 2
    by_id = {item["email_id"]: item for item in body["results"]}
    assert by_id[email_ids[0]]["smtp_status"] == "deliverable"
    assert by_id[unknown_id]["smtp_status"] == "not_checked"
    assert by_id[unknown_id]["smtp_message"] == "email_id not found"
    assert by_id[unknown_id]["email"] is None

    # Confirm no verification row was written for the unknown id.
    async with SessionLocal() as session:
        rows = (
            (
                await session.execute(
                    select(EmailVerification).where(EmailVerification.discovered_email_id == unknown_id)
                )
            )
            .scalars()
            .all()
        )
        assert rows == []


async def test_verify_empty_list_rejected() -> None:
    response = await _post_verify({"email_ids": []})
    assert response.status_code == 422


async def test_verify_duplicate_ids_rejected() -> None:
    response = await _post_verify({"email_ids": [1, 1, 2]})
    assert response.status_code == 422


async def test_verify_batch_size_over_cap_413() -> None:
    # Default cap is 25; submit 26 IDs (no need to seed — handler checks size first).
    response = await _post_verify({"email_ids": list(range(1, 27))})
    assert response.status_code == 413
    body = response.json()
    assert "26" in body["detail"]
    assert "25" in body["detail"]


# --- Concurrency walltime tests --------------------------------------------


async def test_verify_concurrency_parallelism_walltime(monkeypatch: pytest.MonkeyPatch) -> None:
    """Concurrency=5 with 5 IDs at 0.5s/probe → walltime <1.5s (proves parallelism;
    serial would be ~2.5s)."""
    email_ids = await _seed_emails(5)
    monkeypatch.setattr(config.settings, "smtp_verify_concurrency", 5)

    async def fake_slow(_email: str) -> tuple[SmtpStatus, str | None]:
        await asyncio.sleep(0.5)
        return SmtpStatus.deliverable, None

    _patch_check_smtp(monkeypatch, fake_slow)

    start = time.perf_counter()
    response = await _post_verify({"email_ids": email_ids})
    elapsed = time.perf_counter() - start

    assert response.status_code == 200
    assert len(response.json()["results"]) == 5
    assert elapsed < 1.5, f"expected <1.5s for 5 parallel probes at 0.5s each, got {elapsed:.2f}s"


async def test_verify_concurrency_one_still_serializes(monkeypatch: pytest.MonkeyPatch) -> None:
    """Concurrency=1 with 3 IDs at 0.5s/probe → walltime ≥1.4s (proves serialization
    holds at the conservative default)."""
    email_ids = await _seed_emails(3)
    monkeypatch.setattr(config.settings, "smtp_verify_concurrency", 1)

    async def fake_slow(_email: str) -> tuple[SmtpStatus, str | None]:
        await asyncio.sleep(0.5)
        return SmtpStatus.deliverable, None

    _patch_check_smtp(monkeypatch, fake_slow)

    start = time.perf_counter()
    response = await _post_verify({"email_ids": email_ids})
    elapsed = time.perf_counter() - start

    assert response.status_code == 200
    assert len(response.json()["results"]) == 3
    assert elapsed >= 1.4, f"expected ≥1.4s for 3 serial probes at 0.5s each, got {elapsed:.2f}s"

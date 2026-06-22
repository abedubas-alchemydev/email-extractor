"""Integration tests for the stripped Apollo phone-reveal webhook.

The standalone handler updates only ``discovered_email.enriched_phone`` (the DOX
parent also fanned reveals into executive/investor/advisor contact + Form 4
tables). These cover the secret gate plus the set-if-null phone merge keyed on
``apollo_person_id``.

Marked integration: needs a real Postgres with the migration applied.
"""

from __future__ import annotations

import httpx
import pytest

from app.core.config import settings
from app.db.session import SessionLocal
from app.main import app
from app.models.discovered_email import DiscoveredEmail
from app.models.extraction_run import ExtractionRun, RunStatus

pytestmark = pytest.mark.integration

_WEBHOOK = "/api/v1/webhooks/apollo/{secret}/phone-reveal"


async def _seed_row(*, apollo_person_id: str | None, enriched_phone: str | None = None) -> int:
    async with SessionLocal() as session:
        scan = ExtractionRun(domain="example.com", status=RunStatus.completed.value)
        session.add(scan)
        await session.commit()
        await session.refresh(scan)
        row = DiscoveredEmail(
            run_id=scan.id,
            email="jane@example.com",
            domain="example.com",
            source="hunter",
            apollo_person_id=apollo_person_id,
            enriched_phone=enriched_phone,
            enrichment_status="enriched",
        )
        session.add(row)
        await session.commit()
        await session.refresh(row)
        return row.id


def _payload(person_id: str, number: str = "+15551234567") -> dict:
    return {"people": [{"id": person_id, "phone_numbers": [{"sanitized_number": number}]}]}


async def _post(secret: str, payload: dict) -> httpx.Response:
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        return await client.post(_WEBHOOK.format(secret=secret), json=payload)


async def test_bad_secret_returns_404(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "apollo_webhook_secret", "right", raising=False)
    resp = await _post("wrong", _payload("pid-1"))
    assert resp.status_code == 404


async def test_unconfigured_secret_returns_503(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "apollo_webhook_secret", None, raising=False)
    resp = await _post("anything", _payload("pid-1"))
    assert resp.status_code == 503


async def test_valid_reveal_sets_enriched_phone(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "apollo_webhook_secret", "sekret", raising=False)
    pid = "pid-reveal-1"
    row_id = await _seed_row(apollo_person_id=pid)

    resp = await _post("sekret", _payload(pid, "+15559990000"))
    assert resp.status_code == 200
    assert resp.json() == {"rows_updated": 1, "phones_added": 1}

    async with SessionLocal() as session:
        row = await session.get(DiscoveredEmail, row_id)
        assert row is not None
        assert row.enriched_phone == "+15559990000"


async def test_reveal_does_not_clobber_existing_phone(monkeypatch: pytest.MonkeyPatch) -> None:
    """Set-if-null: a row that already has a phone is left untouched."""
    monkeypatch.setattr(settings, "apollo_webhook_secret", "sekret", raising=False)
    pid = "pid-existing"
    row_id = await _seed_row(apollo_person_id=pid, enriched_phone="+15551112222")

    resp = await _post("sekret", _payload(pid, "+15559990000"))
    assert resp.status_code == 200
    assert resp.json() == {"rows_updated": 0, "phones_added": 0}

    async with SessionLocal() as session:
        row = await session.get(DiscoveredEmail, row_id)
        assert row is not None
        assert row.enriched_phone == "+15551112222"


async def test_unmatched_person_id_is_200_noop(monkeypatch: pytest.MonkeyPatch) -> None:
    """Apollo's late callback for a deleted/unknown row is a 200 no-op, not an error."""
    monkeypatch.setattr(settings, "apollo_webhook_secret", "sekret", raising=False)
    resp = await _post("sekret", _payload("nonexistent-pid"))
    assert resp.status_code == 200
    assert resp.json() == {"rows_updated": 0, "phones_added": 0}

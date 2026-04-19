"""Aggregator tests — DB-touching, gated as integration.

Relies on the running backend's Postgres + applied migrations. Local dev
without Docker should run these via the VPS deploy path or against a
local test Postgres.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from app.db.session import SessionLocal
from app.models.discovered_email import DiscoveredEmail
from app.models.email_verification import EmailVerification
from app.models.extraction_run import ExtractionRun, RunStatus
from app.services.email_extractor import aggregator, verification
from app.services.email_extractor.base import (
    DiscoveredEmailDraft,
    DiscoveryResult,
    EmailSource,
)

pytestmark = pytest.mark.integration


class _FakeProvider:
    def __init__(self, name: str, result: DiscoveryResult | Exception) -> None:
        self.name = name
        self._result = result

    async def run(self, domain: str) -> DiscoveryResult:  # noqa: ARG002
        if isinstance(self._result, Exception):
            raise self._result
        return self._result


async def _new_scan(domain: str = "example.com") -> int:
    async with SessionLocal() as session:
        scan = ExtractionRun(domain=domain, status=RunStatus.queued.value)
        session.add(scan)
        await session.commit()
        await session.refresh(scan)
        return scan.id


def _stub_verification(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _ok(_email: str) -> tuple[bool, bool, str | None]:
        return True, True, None

    monkeypatch.setattr(verification, "check_syntax_and_mx", _ok)
    monkeypatch.setattr(aggregator, "check_syntax_and_mx", _ok)


async def test_one_provider_two_drafts_persists_two_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_verification(monkeypatch)
    run_id = await _new_scan()

    provider: EmailSource = _FakeProvider(
        "fake",
        DiscoveryResult(
            emails=[
                DiscoveredEmailDraft(email="a@example.com", source="fake", confidence=0.9),
                DiscoveredEmailDraft(email="b@example.com", source="fake", confidence=0.7),
            ]
        ),
    )

    await aggregator.run(run_id, providers=[provider])

    async with SessionLocal() as session:
        scan = await session.get(ExtractionRun, run_id)
        assert scan is not None
        assert scan.status == RunStatus.completed.value
        assert scan.success_count == 2
        assert scan.failure_count == 0

        rows = (await session.execute(select(DiscoveredEmail).where(DiscoveredEmail.run_id == run_id))).scalars().all()
        assert sorted(r.email for r in rows) == ["a@example.com", "b@example.com"]

        verifications = (
            (
                await session.execute(
                    select(EmailVerification).where(EmailVerification.discovered_email_id.in_([r.id for r in rows]))
                )
            )
            .scalars()
            .all()
        )
        assert len(verifications) == 2
        assert all(v.syntax_valid is True and v.mx_record_present is True for v in verifications)


async def test_one_failing_provider_completes_with_error(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_verification(monkeypatch)
    run_id = await _new_scan()

    good: EmailSource = _FakeProvider(
        "good",
        DiscoveryResult(emails=[DiscoveredEmailDraft(email="x@example.com", source="good", confidence=0.5)]),
    )
    bad: EmailSource = _FakeProvider("bad", RuntimeError("kaboom"))

    await aggregator.run(run_id, providers=[good, bad])

    async with SessionLocal() as session:
        scan = await session.get(ExtractionRun, run_id)
        assert scan is not None
        assert scan.status == RunStatus.completed.value
        assert scan.failure_count == 0
        assert scan.error_message is not None
        assert "bad" in scan.error_message and "kaboom" in scan.error_message


async def test_all_providers_raise_marks_run_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    _stub_verification(monkeypatch)
    run_id = await _new_scan()

    p1: EmailSource = _FakeProvider("p1", RuntimeError("nope"))
    p2: EmailSource = _FakeProvider("p2", RuntimeError("also nope"))

    await aggregator.run(run_id, providers=[p1, p2])

    async with SessionLocal() as session:
        scan = await session.get(ExtractionRun, run_id)
        assert scan is not None
        assert scan.status == RunStatus.failed.value
        assert scan.error_message is not None
        assert "p1" in scan.error_message and "p2" in scan.error_message


async def test_provider_error_gets_single_provider_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    """ADR 0002: provider emits bare error; aggregator wraps with exactly one '<name>: ' prefix."""
    _stub_verification(monkeypatch)
    run_id = await _new_scan()

    provider: EmailSource = _FakeProvider(
        "fake",
        DiscoveryResult(emails=[], errors=["boom"]),
    )

    await aggregator.run(run_id, providers=[provider])

    async with SessionLocal() as session:
        scan = await session.get(ExtractionRun, run_id)
        assert scan is not None
        assert scan.error_message is not None
        assert "fake: boom" in scan.error_message
        assert "fake: fake:" not in scan.error_message


async def test_multiple_providers_get_independent_prefixes(monkeypatch: pytest.MonkeyPatch) -> None:
    """Each provider's errors are prefixed with its own name, exactly once."""
    _stub_verification(monkeypatch)
    run_id = await _new_scan()

    providers: list[EmailSource] = [
        _FakeProvider("alpha", DiscoveryResult(emails=[], errors=["one"])),
        _FakeProvider("beta", DiscoveryResult(emails=[], errors=["two"])),
    ]

    await aggregator.run(run_id, providers=providers)

    async with SessionLocal() as session:
        scan = await session.get(ExtractionRun, run_id)
        assert scan is not None
        assert scan.error_message is not None
        assert "alpha: one" in scan.error_message
        assert "beta: two" in scan.error_message
        assert "alpha: alpha:" not in scan.error_message
        assert "beta: beta:" not in scan.error_message
        assert "alpha: beta:" not in scan.error_message
        assert "beta: alpha:" not in scan.error_message

"""Shared test fixtures.

The email-extractor endpoints gate on a BetterAuth session via
``services.auth.get_current_user``. Rather than mint a signed cookie and seed a
``session`` row in every API test, override that dependency with a fixed
authenticated user (BetterAuth itself is exercised from the frontend). A test
that wants to assert the gate IS enforced pops the override and hits the real
dependency — see ``test_auth_required.py``.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest

from app.main import app
from app.schemas.auth import AuthenticatedUser
from app.services.auth import get_current_user


def _test_user() -> AuthenticatedUser:
    """A fixed admin user that satisfies the auth dependency in API tests."""
    return AuthenticatedUser(
        id="test-user",
        name="Test User",
        email="test@example.com",
        role="admin",
        feature_permissions=["email_extractor"],
        session_expires_at=datetime.now(UTC) + timedelta(hours=1),
    )


@pytest.fixture(autouse=True)
def override_auth() -> Iterator[None]:
    """Auto-authenticate every test as an admin by overriding get_current_user.

    Cleared after each test, so a test can pop the override to exercise the real
    401 path."""
    app.dependency_overrides[get_current_user] = _test_user
    yield
    app.dependency_overrides.pop(get_current_user, None)

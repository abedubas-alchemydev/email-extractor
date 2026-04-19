from __future__ import annotations

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


# Model imports below register tables with Base.metadata so Alembic
# autogenerate sees them. Order matters only when relationships are declared
# without string-form forward references.
from app.models import discovered_email, email_verification, extraction_run  # noqa: E402,F401

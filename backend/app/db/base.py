from __future__ import annotations

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


# Model imports go below this line so Base.metadata is populated for Alembic.
# (No models yet — added in a follow-up prompt.)

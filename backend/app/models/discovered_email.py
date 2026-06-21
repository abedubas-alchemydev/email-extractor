from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

if TYPE_CHECKING:
    from app.models.email_verification import EmailVerification
    from app.models.extraction_run import ExtractionRun


class DiscoverySource(StrEnum):
    hunter = "hunter"
    apollo = "apollo"
    snov = "snov"
    site_crawler = "site_crawler"
    theharvester = "theharvester"


class DiscoveredEmail(Base):
    """A single email discovered during a scan, attributed to its source provider."""

    __tablename__ = "discovered_email"
    __table_args__ = (UniqueConstraint("run_id", "email", name="uq_discovered_email_run_email"),)

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    run_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("extraction_run.id", ondelete="CASCADE"), nullable=False, index=True
    )
    email: Mapped[str] = mapped_column(String(320), nullable=False, index=True)
    domain: Mapped[str] = mapped_column(String(255), nullable=False)
    source: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    confidence: Mapped[float | None] = mapped_column(Float, nullable=True)
    attribution: Mapped[str | None] = mapped_column(Text, nullable=True)
    # --- Enrichment columns ---
    # Populated by the enrichment layer (Phase 2). Inert/NULL until then, but
    # carried in the schema now so a single migration captures the final shape.
    # Standalone is FK-free: no bd_id/advisor_id (the parent had those to link
    # broker_dealers/investment_advisors; this app has neither table).
    enriched_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    enriched_title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    enriched_linkedin_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    enriched_company: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Email surfaced by Apollo enrichment -- the revealed personal email when
    # reveal_personal_emails is on, else the matched work email. Distinct from
    # ``email`` (the discovered address that keyed the /people/match lookup).
    enriched_email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    enriched_phone: Mapped[str | None] = mapped_column(String(64), nullable=True)
    enriched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    enrichment_status: Mapped[str] = mapped_column(String(32), server_default="not_enriched", nullable=False)
    # Apollo person id from /people/match, stamped during enrichment so the async
    # phone-reveal webhook can correlate a revealed number back to this row.
    apollo_person_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    # When the async Apollo phone-reveal was requested. Read by phone_reveal_pending
    # (added with the enrichment layer in Phase 2) to bound the UI spinner with a TTL.
    phone_reveal_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    run: Mapped[ExtractionRun] = relationship(back_populates="discovered_emails")
    verifications: Mapped[list[EmailVerification]] = relationship(
        back_populates="discovered_email", cascade="all, delete-orphan", lazy="selectin"
    )

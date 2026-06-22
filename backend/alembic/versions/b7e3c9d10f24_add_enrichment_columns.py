"""add enrichment columns (fk-free standalone)

Revision ID: b7e3c9d10f24
Revises: a1b2c3d4e5f6
Create Date: 2026-06-21 00:00:00.000000

Brings discovered_email + extraction_run to the final enriched shape so the
Phase 2 enrichment layer drops in without further schema changes. All columns
are nullable/inert until enrichment runs. Standalone stays FK-free: unlike the
DOX parent, no bd_id/advisor_id (no broker_dealers/investment_advisors tables).
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b7e3c9d10f24"
down_revision: str | None = "a1b2c3d4e5f6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Enrichment columns on discovered_email.
    op.add_column("discovered_email", sa.Column("enriched_name", sa.String(length=255), nullable=True))
    op.add_column("discovered_email", sa.Column("enriched_title", sa.String(length=255), nullable=True))
    op.add_column("discovered_email", sa.Column("enriched_linkedin_url", sa.String(length=512), nullable=True))
    op.add_column("discovered_email", sa.Column("enriched_company", sa.String(length=255), nullable=True))
    op.add_column("discovered_email", sa.Column("enriched_email", sa.String(length=320), nullable=True))
    op.add_column("discovered_email", sa.Column("enriched_phone", sa.String(length=64), nullable=True))
    op.add_column("discovered_email", sa.Column("enriched_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "discovered_email",
        sa.Column(
            "enrichment_status",
            sa.String(length=32),
            server_default=sa.text("'not_enriched'"),
            nullable=False,
        ),
    )
    op.add_column("discovered_email", sa.Column("apollo_person_id", sa.String(length=64), nullable=True))
    op.add_column(
        "discovered_email",
        sa.Column("phone_reveal_requested_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        op.f("ix_discovered_email_apollo_person_id"),
        "discovered_email",
        ["apollo_person_id"],
        unique=False,
    )

    # Bulk-enrichment cancel flag on extraction_run.
    op.add_column("extraction_run", sa.Column("enrich_cancelled_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("extraction_run", "enrich_cancelled_at")
    op.drop_index(op.f("ix_discovered_email_apollo_person_id"), table_name="discovered_email")
    op.drop_column("discovered_email", "phone_reveal_requested_at")
    op.drop_column("discovered_email", "apollo_person_id")
    op.drop_column("discovered_email", "enrichment_status")
    op.drop_column("discovered_email", "enriched_at")
    op.drop_column("discovered_email", "enriched_phone")
    op.drop_column("discovered_email", "enriched_email")
    op.drop_column("discovered_email", "enriched_company")
    op.drop_column("discovered_email", "enriched_linkedin_url")
    op.drop_column("discovered_email", "enriched_title")
    op.drop_column("discovered_email", "enriched_name")

"""add betterauth tables (user, session, account, verification)

Revision ID: c8d4e1f2a3b5
Revises: b7e3c9d10f24
Create Date: 2026-06-22 00:00:00.000000

Standalone BetterAuth schema: email + password (the credential hash lives in
account.password) with the session table the backend validates cookies against.
Mirrors BetterAuth's reference schema. verification.value is TEXT (BetterAuth
writes PKCE/state blobs that exceed 255). Auto-approve defaults: a new user is
active + viewer + already granted the single email_extractor feature, so signup
needs no admin step or per-user grant.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c8d4e1f2a3b5"
down_revision: str | None = "b7e3c9d10f24"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "user",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("email_verified", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("image", sa.Text(), nullable=True),
        sa.Column("role", sa.String(length=32), server_default=sa.text("'viewer'"), nullable=False),
        sa.Column("status", sa.String(length=16), server_default=sa.text("'active'"), nullable=False),
        sa.Column(
            "feature_permissions",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("""'["email_extractor"]'::jsonb"""),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_user_email"), "user", ["email"], unique=True)
    op.create_index(op.f("ix_user_status"), "user", ["status"], unique=False)

    op.create_table(
        "session",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("user_id", sa.String(length=255), nullable=False),
        sa.Column("token", sa.String(length=255), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ip_address", sa.String(length=255), nullable=True),
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("last_activity_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_session_user_id"), "session", ["user_id"], unique=False)
    op.create_index(op.f("ix_session_token"), "session", ["token"], unique=True)

    op.create_table(
        "account",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("user_id", sa.String(length=255), nullable=False),
        sa.Column("account_id", sa.String(length=255), nullable=False),
        sa.Column("provider_id", sa.String(length=255), nullable=False),
        sa.Column("access_token", sa.Text(), nullable=True),
        sa.Column("refresh_token", sa.Text(), nullable=True),
        sa.Column("access_token_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("refresh_token_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("scope", sa.Text(), nullable=True),
        sa.Column("id_token", sa.Text(), nullable=True),
        sa.Column("password", sa.Text(), nullable=True),
        sa.Column("email_address", sa.String(length=320), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_account_user_id"), "account", ["user_id"], unique=False)
    op.create_index(op.f("ix_account_email_address"), "account", ["email_address"], unique=False)

    op.create_table(
        "verification",
        sa.Column("id", sa.String(length=255), nullable=False),
        sa.Column("identifier", sa.String(length=320), nullable=False),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("verification")
    op.drop_index(op.f("ix_account_email_address"), table_name="account")
    op.drop_index(op.f("ix_account_user_id"), table_name="account")
    op.drop_table("account")
    op.drop_index(op.f("ix_session_token"), table_name="session")
    op.drop_index(op.f("ix_session_user_id"), table_name="session")
    op.drop_table("session")
    op.drop_index(op.f("ix_user_status"), table_name="user")
    op.drop_index(op.f("ix_user_email"), table_name="user")
    op.drop_table("user")

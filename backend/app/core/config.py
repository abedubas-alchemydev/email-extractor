from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from pydantic import Field, computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parents[2]
PROJECT_ROOT = BACKEND_ROOT.parent
ROOT_ENV_PATH = PROJECT_ROOT / ".env"
BACKEND_ENV_PATH = BACKEND_ROOT / ".env"

# Root env first, backend env second — backend wins on conflict regardless of CWD.
load_dotenv(ROOT_ENV_PATH, override=False)
load_dotenv(BACKEND_ENV_PATH, override=True)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")

    app_name: str = "Email Extractor API"
    api_v1_prefix: str = "/api/v1"
    database_url: str = "postgresql+psycopg://postgres:postgres@localhost:5432/email_extractor"
    backend_cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    # Standalone Bearer auth — replaced by BetterAuth on merge into fis-lead-gen.
    email_extractor_api_key: str | None = None

    # Discovery provider API keys — optional during scaffold phase.
    hunter_api_key: str | None = None

    # Hunter domain-search result cap. Free tier: 10. Paid: up to 100.
    # Hunter returns HTTP 400 if this exceeds the plan max — keep at 10 on free.
    hunter_limit: int = Field(default=10, ge=1, le=100)

    # theHarvester OSINT provider — comma-separated source list and per-call timeout.
    # Defaults are free-only sources that don't require API keys.
    theharvester_sources: str = "crtsh,rapiddns,otx,duckduckgo"
    theharvester_timeout_seconds: int = Field(default=90, ge=10, le=300)

    # Snov.io provider — OAuth2 client_credentials. Both id + secret required;
    # missing either short-circuits to a "credentials not configured" bare error
    # without making any HTTP call. snov_limit bounds: 1..1000, default 100
    # (Snov free tier typically allows up to 100 emails per call).
    snov_client_id: str | None = None
    snov_client_secret: str | None = None
    snov_limit: int = Field(default=100, ge=1, le=1000)

    # SMTP verification (POST /verify) — knobs for the per-email RCPT TO probe.
    # Concurrency defaults to 1 (fully serial) to avoid tripping target MTAs;
    # raise per-domain later once probe behaviour is measured. The HELO host
    # and FROM address default to a non-routable identity; swap to a real
    # mailbox once SPF/DKIM is set up for the Email Extractor sender domain.
    smtp_verify_timeout_seconds: int = Field(default=15, ge=5, le=60)
    smtp_verify_max_batch: int = Field(default=25, ge=1, le=100)
    smtp_verify_concurrency: int = Field(default=1, ge=1, le=10)
    smtp_verify_from_address: str = "verify@email-extractor.local"
    smtp_verify_helo_host: str = "email-extractor.local"

    @computed_field
    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.backend_cors_origins.split(",") if origin.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings = get_settings()

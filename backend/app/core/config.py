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
    apollo_api_key: str | None = None
    snov_api_key: str | None = None

    # Hunter domain-search result cap. Free tier: 10. Paid: up to 100.
    # Hunter returns HTTP 400 if this exceeds the plan max — keep at 10 on free.
    hunter_limit: int = Field(default=10, ge=1, le=100)

    @computed_field
    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.backend_cors_origins.split(",") if origin.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings = get_settings()

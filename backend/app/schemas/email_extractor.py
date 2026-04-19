from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ScanCreateRequest(BaseModel):
    """Inbound payload for POST /api/v1/email-extractor/scans."""

    domain: str = Field(min_length=1, max_length=255, description="Domain to scan, e.g. 'example.com'")
    person_name: str | None = Field(default=None, max_length=255)


class EmailVerificationResponse(BaseModel):
    id: int
    syntax_valid: bool | None
    mx_record_present: bool | None
    smtp_status: str
    smtp_message: str | None
    checked_at: datetime

    model_config = ConfigDict(from_attributes=True)


class DiscoveredEmailResponse(BaseModel):
    id: int
    email: str
    domain: str
    source: str
    confidence: float | None
    attribution: str | None
    created_at: datetime
    verifications: list[EmailVerificationResponse] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class ScanResponse(BaseModel):
    """Returned by both POST and GET /scans endpoints."""

    id: int
    pipeline_name: str
    domain: str
    person_name: str | None
    status: str
    total_items: int
    processed_items: int
    success_count: int
    failure_count: int
    error_message: str | None
    created_at: datetime
    started_at: datetime | None
    completed_at: datetime | None
    discovered_emails: list[DiscoveredEmailResponse] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)

"""Hunter.io Domain Search provider.

Hits ``GET https://api.hunter.io/v2/domain-search?domain=...&api_key=...&limit=100``
and translates the response into ``DiscoveredEmailDraft`` rows. Never raises;
every failure mode (missing key, 4xx/5xx, timeout, parse error) is captured
as a structured string in ``DiscoveryResult.errors`` so the aggregator can
keep running other providers and finalise the scan cleanly.

Tier-agnostic: free-tier accounts return ~10 emails per call regardless of
``limit``; paid tiers respect ``limit=100``. Hunter charges 1 credit per call
no matter the response size, so we don't paginate.

Hunter's own auto-verification status (when present) is *recorded* in
``attribution`` for human inspection but does NOT replace our own
``email-validator`` syntax + MX check, which the aggregator runs inline on
every persisted draft.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from app.core.config import settings
from app.services.email_extractor.base import DiscoveredEmailDraft, DiscoveryResult

logger = logging.getLogger(__name__)

DOMAIN_SEARCH_URL = "https://api.hunter.io/v2/domain-search"
REQUEST_TIMEOUT_SECONDS = 30.0
DEFAULT_LIMIT = 100
ATTRIBUTION_CHAR_CAP = 500


class Hunter:
    """``EmailSource`` Protocol implementation backed by Hunter.io."""

    name = "hunter"

    async def run(self, domain: str) -> DiscoveryResult:
        api_key = settings.hunter_api_key
        if not api_key:
            return DiscoveryResult(errors=["hunter_api_key not configured"])

        params = {"domain": domain, "api_key": api_key, "limit": DEFAULT_LIMIT}

        try:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
                response = await client.get(DOMAIN_SEARCH_URL, params=params)
        except httpx.TimeoutException:
            return DiscoveryResult(errors=["hunter: timeout"])
        except Exception as exc:  # noqa: BLE001
            return DiscoveryResult(errors=[f"hunter: {exc.__class__.__name__}"])

        if response.status_code == 401:
            return DiscoveryResult(errors=["hunter: invalid api key"])
        if response.status_code == 402:
            return DiscoveryResult(errors=["hunter: out of credits"])
        if response.status_code == 403:
            return DiscoveryResult(errors=["hunter: account forbidden"])
        if response.status_code == 429:
            return DiscoveryResult(errors=["hunter: rate limited"])
        if response.status_code >= 500:
            return DiscoveryResult(errors=[f"hunter: upstream error {response.status_code}"])
        if response.status_code != 200:
            return DiscoveryResult(errors=[f"hunter: unexpected status {response.status_code}"])

        try:
            payload: dict[str, Any] = response.json()
        except ValueError as exc:
            return DiscoveryResult(errors=[f"hunter: invalid json: {exc}"])

        data = payload.get("data") or {}
        raw_emails = data.get("emails") or []
        drafts: list[DiscoveredEmailDraft] = []
        for entry in raw_emails:
            draft = _entry_to_draft(entry)
            if draft is not None:
                drafts.append(draft)

        return DiscoveryResult(emails=drafts)


def _entry_to_draft(entry: dict[str, Any]) -> DiscoveredEmailDraft | None:
    email = entry.get("value")
    if not isinstance(email, str) or not email:
        return None

    raw_confidence = entry.get("confidence")
    confidence = float(raw_confidence) / 100.0 if isinstance(raw_confidence, (int, float)) else None

    attribution = _format_attribution(entry)
    return DiscoveredEmailDraft(
        email=email.lower(),
        source="hunter",
        confidence=confidence,
        attribution=attribution,
    )


def _format_attribution(entry: dict[str, Any]) -> str:
    position = entry.get("position") or "-"
    email_type = entry.get("type") or "-"
    verification = entry.get("verification") or {}
    verified = verification.get("status") if isinstance(verification, dict) else None
    sources = entry.get("sources") or []
    first_uri = "-"
    if sources and isinstance(sources, list):
        first = sources[0]
        if isinstance(first, dict):
            first_uri = str(first.get("uri") or "-")

    text = f"hunter: {position} | {email_type} | verified={verified or 'unknown'} | src={first_uri}"
    return text[:ATTRIBUTION_CHAR_CAP]

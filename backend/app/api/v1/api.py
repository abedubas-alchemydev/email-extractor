from __future__ import annotations

from fastapi import APIRouter

from app.api.v1.endpoints import email_extractor, health, webhooks_apollo

api_router = APIRouter()
api_router.include_router(health.router, tags=["health"])
api_router.include_router(email_extractor.router)
# Apollo async phone-reveal callback → /api/v1/webhooks/apollo/{secret}/phone-reveal
api_router.include_router(webhooks_apollo.router, tags=["webhooks"])

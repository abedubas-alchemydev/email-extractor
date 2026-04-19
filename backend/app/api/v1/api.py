from __future__ import annotations

from fastapi import APIRouter

from app.api.v1.endpoints import email_extractor, health

api_router = APIRouter()
api_router.include_router(health.router, tags=["health"])
api_router.include_router(email_extractor.router)

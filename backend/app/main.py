from __future__ import annotations

import asyncio
import logging
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.router import api_router
from app.core.config import settings
from app.db.session import engine

# Windows requires the selector loop policy for psycopg under uvicorn.
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Startup: the SQLAlchemy engine is constructed at module import time
    # (see app.db.session). httpx clients are per-request — each call site uses
    # `async with httpx.AsyncClient(...) as client`, so there are no long-lived
    # HTTP pools to initialize here.
    try:
        yield
    finally:
        # Shutdown: drain the async SQLAlchemy engine so Postgres observes a
        # clean TCP FIN rather than reclaiming the connection via idle detection
        # on container shutdown / Cloud Run revision swap.
        try:
            await engine.dispose()
        except Exception:  # noqa: BLE001
            logger.warning("Engine dispose raised during shutdown", exc_info=True)


app = FastAPI(
    title=settings.app_name,
    docs_url=f"{settings.api_v1_prefix}/docs",
    openapi_url=f"{settings.api_v1_prefix}/openapi.json",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health", tags=["system"])
async def root_health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(api_router, prefix=settings.api_v1_prefix)

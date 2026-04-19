from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

from app.db.session import SessionLocal
from app.models.extraction_run import ExtractionRun, RunStatus

logger = logging.getLogger(__name__)


async def run(run_id: int) -> None:
    """Stub aggregator: flips status queued -> running -> (sleep) -> completed.

    Real provider fan-out (Hunter / Apollo / Snov / site crawler / theHarvester)
    arrives in dedicated follow-up prompts. This stub exists so the state-machine
    wiring is observable end-to-end via POST + poll.

    Opens its own SessionLocal — never reuse a request-scoped session here, it
    will be closed by the time FastAPI runs the BackgroundTasks queue.
    """
    async with SessionLocal() as session:
        scan = await session.get(ExtractionRun, run_id)
        if scan is None:
            logger.warning("aggregator.run: run_id=%s not found", run_id)
            return
        scan.status = RunStatus.running.value
        scan.started_at = datetime.now(UTC)
        await session.commit()

    await asyncio.sleep(1.5)

    async with SessionLocal() as session:
        scan = await session.get(ExtractionRun, run_id)
        if scan is None:
            return
        scan.status = RunStatus.completed.value
        scan.completed_at = datetime.now(UTC)
        await session.commit()

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.session import get_db_session
from app.models.extraction_run import ExtractionRun, RunStatus
from app.schemas.email_extractor import ScanCreateRequest, ScanResponse
from app.services.email_extractor import aggregator

router = APIRouter(prefix="/email-extractor", tags=["email-extractor"])


@router.post("/scans", status_code=status.HTTP_202_ACCEPTED, response_model=ScanResponse)
async def create_scan(
    payload: ScanCreateRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db_session),
) -> ExtractionRun:
    scan = ExtractionRun(
        domain=payload.domain,
        person_name=payload.person_name,
        status=RunStatus.queued.value,
    )
    db.add(scan)
    await db.commit()
    await db.refresh(scan)
    background_tasks.add_task(aggregator.run, scan.id)
    return scan


@router.get("/scans/{run_id}", response_model=ScanResponse)
async def get_scan(
    run_id: int,
    db: AsyncSession = Depends(get_db_session),
) -> ExtractionRun:
    stmt = (
        select(ExtractionRun).where(ExtractionRun.id == run_id).options(selectinload(ExtractionRun.discovered_emails))
    )
    result = await db.execute(stmt)
    scan = result.scalar_one_or_none()
    if scan is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="scan not found")
    return scan

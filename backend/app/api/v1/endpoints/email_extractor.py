from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.config import settings
from app.db.session import get_db_session
from app.models.discovered_email import DiscoveredEmail
from app.models.email_verification import EmailVerification, SmtpStatus
from app.models.extraction_run import ExtractionRun, RunStatus
from app.schemas.email_extractor import (
    ScanCreateRequest,
    ScanResponse,
    VerifyRequest,
    VerifyResponse,
    VerifyResultItem,
)
from app.services.email_extractor import aggregator
from app.services.email_extractor.verification import check_smtp

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


@router.post("/verify", response_model=VerifyResponse)
async def verify_emails(
    payload: VerifyRequest,
    db: AsyncSession = Depends(get_db_session),
) -> VerifyResponse:
    if len(payload.email_ids) > settings.smtp_verify_max_batch:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"batch size {len(payload.email_ids)} exceeds cap {settings.smtp_verify_max_batch}",
        )

    rows = (await db.execute(select(DiscoveredEmail).where(DiscoveredEmail.id.in_(payload.email_ids)))).scalars().all()
    by_id = {row.id: row for row in rows}

    semaphore = asyncio.Semaphore(settings.smtp_verify_concurrency)

    async def _verify_one(discovered: DiscoveredEmail) -> VerifyResultItem:
        async with semaphore:
            smtp_status, smtp_message = await check_smtp(discovered.email)
        verification = EmailVerification(
            discovered_email_id=discovered.id,
            smtp_status=smtp_status.value,
            smtp_message=smtp_message,
        )
        db.add(verification)
        await db.flush()
        await db.refresh(verification)
        return VerifyResultItem(
            email_id=discovered.id,
            email=discovered.email,
            smtp_status=verification.smtp_status,
            smtp_message=verification.smtp_message,
            checked_at=verification.checked_at,
        )

    async def _resolve(email_id: int) -> VerifyResultItem:
        discovered = by_id.get(email_id)
        if discovered is None:
            # Unknown ID — surface a synthetic item rather than 404'ing the whole batch.
            return VerifyResultItem(
                email_id=email_id,
                email=None,
                smtp_status=SmtpStatus.not_checked.value,
                smtp_message="email_id not found",
                checked_at=datetime.now(UTC),
            )
        return await _verify_one(discovered)

    results = await asyncio.gather(*(_resolve(eid) for eid in payload.email_ids))
    await db.commit()
    return VerifyResponse(results=list(results))

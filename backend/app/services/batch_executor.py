"""Sequential in-process executor for Batch Test runs."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from uuid import uuid4

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session_factory
from app.models.run import AttemptORM, RunItemORM, RunSessionORM
from app.schemas.common import RunItemType, RunSessionStatus, RunType, utc_now
from app.schemas.model_config import ModelConfigSnapshot
from app.schemas.prompt import ImageSlotSpec
from app.schemas.run_record import ConfigSnapshot, RunSource, RunSummary
from app.schemas.sample_record import SampleRecord
from app.services.request_builder import _pricing_snapshot
from app.services.run_executor import LabRunRequest, _make_prompt_snapshot, execute_lab_run


@dataclass(frozen=True)
class BatchRunSpec:
    run_id: str
    name: str
    source: RunSource | dict
    samples: list[SampleRecord]
    request_template: LabRunRequest


_running_tasks: dict[str, asyncio.Task] = {}
_cancel_events: dict[str, asyncio.Event] = {}


async def start_batch_run(spec: BatchRunSpec) -> str:
    """Create the batch session row and start a background worker."""

    cancel_event = asyncio.Event()
    _cancel_events[spec.run_id] = cancel_event

    factory = get_session_factory()
    async with factory() as db:
        await _create_session(db, spec)
        await db.commit()

    task = asyncio.create_task(_run_batch_worker(spec, cancel_event))
    _running_tasks[spec.run_id] = task
    task.add_done_callback(lambda _task: _cleanup_task(spec.run_id))
    return spec.run_id


def request_cancel(run_id: str) -> bool:
    """Signal cancellation for a running batch task."""

    event = _cancel_events.get(run_id)
    task = _running_tasks.get(run_id)
    found = event is not None or task is not None
    if event is not None:
        event.set()
    if task is not None and not task.done():
        task.cancel()
    return found


async def _create_session(db: AsyncSession, spec: BatchRunSpec) -> None:
    request = spec.request_template
    prompt_snapshot = _make_prompt_snapshot(
        request.prompt,
        image_slot_specs=request.image_slot_specs,
        variable_specs=request.variable_specs,
    )
    model_snapshot = ModelConfigSnapshot(
        model_config_id=request.model_config.model_config_id,
        provider_id=request.model_config.provider_id,
        model_id=request.model_config.model_id,
        adapter_id=request.model_config.adapter_id,
        parameters=request.model_config.parameters,
        provider_options=request.model_config.provider_options,
    )
    pricing_snapshot = _pricing_snapshot(request.pricing)
    now = utc_now().isoformat()
    session = RunSessionORM(
        run_id=spec.run_id,
        run_type=RunType.BATCH.value,
        name=spec.name or f"Batch: {len(spec.samples)} samples",
        status=RunSessionStatus.RUNNING.value,
        started_at=now,
        source=(
            spec.source.model_dump(mode="json")
            if isinstance(spec.source, RunSource)
            else spec.source
        ),
        config_snapshot=ConfigSnapshot(
            prompt_version=prompt_snapshot,
            model_config_snapshot=model_snapshot,
            output_contract=request.output_contract,
            pricing_profile=pricing_snapshot,
        ).model_dump(mode="json"),
        summary=RunSummary(
            total_items=len(spec.samples),
            currency=pricing_snapshot.currency,
        ).model_dump(mode="json"),
    )
    db.add(session)
    await db.flush()


async def _run_batch_worker(spec: BatchRunSpec, cancel_event: asyncio.Event) -> None:
    factory = get_session_factory()
    async with factory() as db:
        try:
            for index, sample in enumerate(spec.samples):
                if cancel_event.is_set():
                    await _mark_remaining_cancelled(db, spec.run_id, spec.samples[index:])
                    await _refresh_session_summary(
                        db,
                        spec.run_id,
                        final_status=RunSessionStatus.CANCELLED.value,
                    )
                    await db.commit()
                    return

                item = await _create_pending_item(db, spec.run_id, sample)
                await db.commit()

                try:
                    await _execute_one_item(db, spec, sample, item)
                    await _refresh_session_summary(db, spec.run_id)
                    await db.commit()
                except asyncio.CancelledError:
                    cancel_event.set()
                    await db.rollback()
                    async with factory() as cancel_db:
                        await _cancel_unfinished(cancel_db, spec.run_id, spec.samples[index:])
                        await _refresh_session_summary(
                            cancel_db,
                            spec.run_id,
                            final_status=RunSessionStatus.CANCELLED.value,
                        )
                        await cancel_db.commit()
                    return
                except Exception as exc:
                    await db.rollback()
                    async with factory() as error_db:
                        await _mark_item_failed(error_db, item.run_item_id, str(exc))
                        await _refresh_session_summary(error_db, spec.run_id)
                        await error_db.commit()

                if cancel_event.is_set():
                    await _mark_remaining_cancelled(db, spec.run_id, spec.samples[index + 1 :])
                    await _refresh_session_summary(
                        db,
                        spec.run_id,
                        final_status=RunSessionStatus.CANCELLED.value,
                    )
                    await db.commit()
                    return

            await _refresh_session_summary(db, spec.run_id, completed=True)
            await db.commit()
        except asyncio.CancelledError:
            async with factory() as cancel_db:
                await _cancel_unfinished(cancel_db, spec.run_id, spec.samples)
                await _refresh_session_summary(
                    cancel_db,
                    spec.run_id,
                    final_status=RunSessionStatus.CANCELLED.value,
                )
                await cancel_db.commit()


async def _create_pending_item(
    db: AsyncSession,
    run_id: str,
    sample: SampleRecord,
) -> RunItemORM:
    item = RunItemORM(
        run_item_id=f"ritem_{uuid4().hex[:16]}",
        run_id=run_id,
        sample_id=sample.sample_id,
        status=RunItemType.PENDING.value,
    )
    db.add(item)
    await db.flush()
    return item


async def _execute_one_item(
    db: AsyncSession,
    spec: BatchRunSpec,
    sample: SampleRecord,
    batch_item: RunItemORM,
) -> None:
    template = spec.request_template
    mapped_sample = sample
    if template.image_slot_specs:
        mapped_sample = map_sample_images_to_prompt_slots(sample, template.image_slot_specs)
    request = LabRunRequest(
        sample=mapped_sample,
        prompt=template.prompt,
        model_config=template.model_config,
        output_contract=template.output_contract,
        pricing=template.pricing,
        api_base_url=template.api_base_url,
        run_name=f"Batch item: {sample.sample_id}",
        provider_config_id=template.provider_config_id,
        image_resolution_enabled=template.image_resolution_enabled,
        image_resolution_target=template.image_resolution_target,
        image_slot_specs=template.image_slot_specs,
        variable_specs=template.variable_specs,
    )

    batch_item.status = RunItemType.RUNNING.value
    batch_item.started_at = utc_now().isoformat()
    await db.flush()

    lab_session = await execute_lab_run(db, request, stream_callback=None)
    temp_run_id = lab_session.run_id

    result = await db.execute(select(RunItemORM).where(RunItemORM.run_id == temp_run_id))
    temp_item = result.scalar_one()
    _copy_item_result(temp_item, batch_item, spec.run_id)

    attempts_result = await db.execute(
        select(AttemptORM).where(AttemptORM.run_item_id == temp_item.run_item_id)
    )
    for attempt in attempts_result.scalars().all():
        attempt.run_item_id = batch_item.run_item_id

    await db.execute(delete(RunItemORM).where(RunItemORM.run_item_id == temp_item.run_item_id))
    await db.execute(delete(RunSessionORM).where(RunSessionORM.run_id == temp_run_id))
    await db.flush()


def map_sample_images_to_prompt_slots(
    sample: SampleRecord,
    image_slot_specs: list[ImageSlotSpec],
) -> SampleRecord:
    """Return a copy of sample with image.order aligned to prompt slot role hints."""

    slots = image_slot_specs or []
    if not slots:
        return sample

    remaining = list(sample.images)
    ordered_images = []
    order = 0

    for slot in slots:
        role_hint = (slot.role_hint or "").strip()
        matches = [image for image in remaining if role_hint and image.role == role_hint]
        min_count = max(1, slot.min_count) if slot.required else max(0, slot.min_count)
        if len(matches) < min_count:
            raise ValueError(
                f"Sample '{sample.sample_id}' is missing image for required prompt slot "
                f"'{slot.slot_id or slot.label}' with role '{role_hint}'."
            )
        max_count = slot.max_count if slot.max_count is not None else len(matches)
        selected = matches[:max_count]
        for image in selected:
            remaining.remove(image)
            ordered_images.append(image.model_copy(update={"order": order}, deep=True))
            order += 1

    for image in sorted(remaining, key=lambda item: item.order):
        ordered_images.append(image.model_copy(update={"order": order}, deep=True))
        order += 1

    return sample.model_copy(update={"images": ordered_images}, deep=True)


def _copy_item_result(source: RunItemORM, target: RunItemORM, run_id: str) -> None:
    target.run_id = run_id
    target.status = source.status
    target.started_at = target.started_at or source.started_at
    target.completed_at = source.completed_at
    target.internal_request_snapshot = source.internal_request_snapshot
    target.prompt_snapshot = source.prompt_snapshot
    target.model_config_snapshot = source.model_config_snapshot
    target.output_contract_snapshot = source.output_contract_snapshot
    target.pricing_snapshot = source.pricing_snapshot
    target.final_attempt_id = source.final_attempt_id
    target.response = source.response
    target.usage = source.usage
    target.cost = source.cost
    target.review = source.review
    target.error = source.error
    target.compare_axes = source.compare_axes
    target.provider_id = source.provider_id
    target.model_id = source.model_id
    target.estimated_cost = source.estimated_cost
    target.latency_ms = source.latency_ms
    target.accepted = source.accepted
    target.rating = source.rating
    target.updated_at = utc_now().isoformat()


async def _mark_item_failed(db: AsyncSession, run_item_id: str, message: str) -> None:
    result = await db.execute(select(RunItemORM).where(RunItemORM.run_item_id == run_item_id))
    item = result.scalar_one_or_none()
    if item is None:
        return
    item.status = RunItemType.FAILED.value
    item.completed_at = utc_now().isoformat()
    item.error = {"type": "unknown_error", "message": message, "retryable": False}


async def _cancel_unfinished(
    db: AsyncSession,
    run_id: str,
    samples: list[SampleRecord],
) -> None:
    existing_result = await db.execute(select(RunItemORM).where(RunItemORM.run_id == run_id))
    existing_by_sample = {item.sample_id: item for item in existing_result.scalars().all()}
    now = utc_now().isoformat()
    for sample in samples:
        item = existing_by_sample.get(sample.sample_id)
        if item is None:
            item = RunItemORM(
                run_item_id=f"ritem_{uuid4().hex[:16]}",
                run_id=run_id,
                sample_id=sample.sample_id,
                status=RunItemType.CANCELLED.value,
                completed_at=now,
            )
            db.add(item)
        elif item.status in {RunItemType.PENDING.value, RunItemType.RUNNING.value}:
            item.status = RunItemType.CANCELLED.value
            item.completed_at = now
            item.updated_at = now
    await db.flush()


async def _mark_remaining_cancelled(
    db: AsyncSession,
    run_id: str,
    samples: list[SampleRecord],
) -> None:
    await _cancel_unfinished(db, run_id, samples)


async def _refresh_session_summary(
    db: AsyncSession,
    run_id: str,
    *,
    completed: bool = False,
    final_status: str | None = None,
) -> None:
    session_result = await db.execute(select(RunSessionORM).where(RunSessionORM.run_id == run_id))
    session = session_result.scalar_one_or_none()
    if session is None:
        return

    items_result = await db.execute(select(RunItemORM).where(RunItemORM.run_id == run_id))
    items = items_result.scalars().all()
    summary = RunSummary(**(session.summary or {}))
    summary.total_items = max(summary.total_items, len(items))
    summary.succeeded_items = sum(1 for item in items if item.status == RunItemType.SUCCEEDED.value)
    summary.failed_items = sum(1 for item in items if item.status == RunItemType.FAILED.value)
    summary.cancelled_items = sum(1 for item in items if item.status == RunItemType.CANCELLED.value)
    summary.skipped_items = sum(1 for item in items if item.status == RunItemType.SKIPPED.value)
    summary.total_attempts = sum(1 for item in items if item.final_attempt_id)
    summary.total_cost_estimated = sum(float(item.estimated_cost or 0.0) for item in items)
    summary.total_input_tokens = sum(
        int((item.usage or {}).get("input_tokens") or 0) for item in items
    )
    summary.total_output_tokens = sum(
        int((item.usage or {}).get("output_tokens") or 0) for item in items
    )
    summary.total_image_count = sum(
        int((item.usage or {}).get("image_count") or 0) for item in items
    )
    summary.total_latency_ms = sum(int(item.latency_ms or 0) for item in items)
    completed_latencies = [int(item.latency_ms or 0) for item in items if item.completed_at]
    summary.avg_latency_ms = (
        float(summary.total_latency_ms) / len(completed_latencies) if completed_latencies else 0.0
    )
    session.summary = summary.model_dump(mode="json")
    session.updated_at = utc_now().isoformat()

    if final_status is not None:
        session.status = final_status
        session.completed_at = utc_now().isoformat()
    elif completed:
        session.status = (
            RunSessionStatus.COMPLETED_WITH_ERRORS.value
            if summary.failed_items
            else RunSessionStatus.COMPLETED.value
        )
        session.completed_at = utc_now().isoformat()
    else:
        session.status = RunSessionStatus.RUNNING.value


def _cleanup_task(run_id: str) -> None:
    _running_tasks.pop(run_id, None)
    _cancel_events.pop(run_id, None)

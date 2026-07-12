"""Unified matrix executor for Batch and Compare runs."""

from __future__ import annotations

import asyncio
import contextlib
import random
from dataclasses import dataclass, field
from uuid import uuid4

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.database import get_session_factory
from app.models.run import AttemptORM, RunItemORM, RunSessionORM
from app.schemas.common import (
    RETRYABLE_ERROR_TYPES,
    RunItemType,
    RunSessionStatus,
    RunType,
    utc_now,
)
from app.schemas.model_config import ModelConfigSnapshot
from app.schemas.prompt import ImageSlotSpec
from app.schemas.run_record import ConfigSnapshot, RunSource, RunSummary
from app.schemas.sample_record import SampleRecord
from app.services.request_builder import _pricing_snapshot
from app.services.run_executor import LabRunRequest, _make_prompt_snapshot, execute_lab_run
from app.services.sample_mapping import apply_sample_mapping

# Concurrency ceilings (clamped again at payload time).
MAX_CONCURRENCY = 16
MAX_RETRIES = 10

# Transient provider/network errors worth retrying with backoff.
_RETRYABLE_ERROR_TYPES = frozenset(error_type.value for error_type in RETRYABLE_ERROR_TYPES)
_BACKOFF_BASE_SECONDS: dict[str, float] = {
    "rate_limit": 5.0,
    "timeout": 2.0,
    "network_error": 2.0,
}
_BACKOFF_MAX_SECONDS = 60.0
_BACKOFF_JITTER_SECONDS = 0.5

# Item statuses that mean an item is finished and must not be re-executed.
# NOTE: FAILED is intentionally excluded — a failed attempt may be retried.
_DONE_ITEM_STATUSES = frozenset(
    {
        RunItemType.SUCCEEDED.value,
        RunItemType.CANCELLED.value,
        RunItemType.SKIPPED.value,
    }
)


@dataclass(frozen=True)
class _MatrixVariant:
    """One column in the execution matrix. Batch runs have exactly one."""

    label: str
    request_template: LabRunRequest
    variable_mapping: dict[str, str] = field(default_factory=dict)
    image_role_mapping: dict[str, str] = field(default_factory=dict)
    # Metadata for compare_axes. None/unused for batch runs.
    task_id: str | None = None
    task_version_id: str | None = None
    prompt_id: str | None = None
    prompt_version_id: str | None = None
    has_axes: bool = False  # True for compare, False for batch


@dataclass(frozen=True)
class _MatrixRunSpec:
    run_id: str
    name: str
    source: RunSource | dict
    samples: list[SampleRecord]
    variants: list[_MatrixVariant]
    run_type: str  # RunType.BATCH.value or RunType.COMPARE.value
    max_concurrency: int = 1
    max_retries: int = 0
    pipeline_id: str | None = None
    pipeline_step: str | None = None


@dataclass(frozen=True)
class _MatrixCell:
    sample: SampleRecord
    variant: _MatrixVariant


_running_tasks: dict[str, asyncio.Task] = {}
_cancel_events: dict[str, asyncio.Event] = {}


async def start_matrix_run(spec: _MatrixRunSpec) -> str:
    cancel_event = asyncio.Event()
    _cancel_events[spec.run_id] = cancel_event

    factory = get_session_factory()
    async with factory() as db:
        await _create_matrix_session(db, spec)
        await db.commit()

    task = asyncio.create_task(_run_matrix_worker(spec, cancel_event))
    _running_tasks[spec.run_id] = task
    task.add_done_callback(lambda _task: _cleanup_task(spec.run_id))
    return spec.run_id


def request_matrix_cancel(run_id: str) -> bool:
    event = _cancel_events.get(run_id)
    task = _running_tasks.get(run_id)
    found = event is not None or task is not None
    if event is not None:
        event.set()
    if task is not None and not task.done():
        task.cancel()
    return found


async def _create_matrix_session(db: AsyncSession, spec: _MatrixRunSpec) -> None:
    first_variant = spec.variants[0] if spec.variants else None
    request = first_variant.request_template if first_variant else None
    config_snapshot = ConfigSnapshot()
    currency = "USD"
    if request is not None:
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
        currency = pricing_snapshot.currency
        config_snapshot = ConfigSnapshot(
            prompt_version=prompt_snapshot,
            model_config_snapshot=model_snapshot,
            output_contract=request.output_contract,
            pricing_profile=pricing_snapshot,
        )

    total_items = len(spec.samples) * len(spec.variants)
    if spec.run_type == RunType.BATCH.value:
        name = spec.name or f"Batch: {len(spec.samples)} samples"
    else:
        name = spec.name or f"Compare: {len(spec.samples)} samples × {len(spec.variants)} variants"

    session = RunSessionORM(
        run_id=spec.run_id,
        run_type=spec.run_type,
        name=name,
        status=RunSessionStatus.RUNNING.value,
        started_at=utc_now().isoformat(),
        source=(
            spec.source.model_dump(mode="json")
            if isinstance(spec.source, RunSource)
            else spec.source
        ),
        config_snapshot=config_snapshot.model_dump(mode="json"),
        summary=RunSummary(
            total_items=total_items,
            currency=currency,
        ).model_dump(mode="json"),
        pipeline_id=spec.pipeline_id,
        pipeline_step=spec.pipeline_step,
    )
    db.add(session)
    await db.flush()


async def _run_matrix_worker(spec: _MatrixRunSpec, cancel_event: asyncio.Event) -> None:
    cells = [
        _MatrixCell(sample=sample, variant=variant)
        for sample in spec.samples
        for variant in spec.variants
    ]
    factory = get_session_factory()
    max_concurrency = max(1, min(spec.max_concurrency, MAX_CONCURRENCY))
    max_attempts = max(1, spec.max_retries + 1)
    summary_lock = asyncio.Lock()
    item_ids: dict[int, str] = {}

    try:
        async with factory() as db:
            for index, cell in enumerate(cells):
                item = await _create_pending_cell_item(db, spec.run_id, cell)
                item_ids[index] = item.run_item_id
            await _refresh_session_summary(db, spec.run_id)
            await db.commit()
    except asyncio.CancelledError:
        cancel_event.set()
        await _finalize_worker(factory, spec, cells, cancel_event)
        return

    semaphore = asyncio.Semaphore(max_concurrency)

    async def run_one(index: int, cell: _MatrixCell) -> None:
        async with semaphore:
            if cancel_event.is_set():
                return
            item_id = item_ids.get(index)
            if item_id:
                await _execute_cell_with_retry(
                    factory, spec, cell, item_id, cancel_event, max_attempts, summary_lock
                )

    try:
        await asyncio.gather(
            *(run_one(i, cell) for i, cell in enumerate(cells)),
            return_exceptions=True,
        )
    except asyncio.CancelledError:
        cancel_event.set()

    await _finalize_worker(factory, spec, cells, cancel_event)


async def _finalize_worker(
    factory: async_sessionmaker[AsyncSession],
    spec: _MatrixRunSpec,
    cells: list[_MatrixCell],
    cancel_event: asyncio.Event,
) -> None:
    async with factory() as db:
        if cancel_event.is_set():
            await _cancel_unfinished(db, spec.run_id, cells)
            await _refresh_session_summary(
                db, spec.run_id, final_status=RunSessionStatus.CANCELLED.value
            )
        else:
            await _refresh_session_summary(db, spec.run_id, completed=True)
        await db.commit()


async def _execute_cell_with_retry(
    factory: async_sessionmaker[AsyncSession],
    spec: _MatrixRunSpec,
    cell: _MatrixCell,
    run_item_id: str,
    cancel_event: asyncio.Event,
    max_attempts: int,
    summary_lock: asyncio.Lock,
) -> None:
    """Run one matrix cell, retrying transient (rate_limit/timeout/network) errors."""
    for attempt in range(1, max_attempts + 1):
        if cancel_event.is_set():
            return
        error_type: str | None = None
        try:
            async with factory() as db:
                result = await db.execute(
                    select(RunItemORM).where(RunItemORM.run_item_id == run_item_id)
                )
                item = result.scalar_one_or_none()
                # Skip if a concurrent finalizer already terminalized it.
                if item is None or item.status in _DONE_ITEM_STATUSES:
                    return
                await _execute_one_cell(db, spec, cell, item)
                succeeded = item.status == RunItemType.SUCCEEDED.value
                error_type = _error_type(item.error)
                # Serialize summary recompute + commit: SQLite has a single
                # writer and session.summary must not lose a concurrent update.
                async with summary_lock:
                    await _refresh_session_summary(db, spec.run_id)
                    await db.commit()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Unexpected infrastructural failure (not a provider error) —
            # record it and stop; the matrix layer does not retry these.
            await _record_unexpected_failure(
                factory, spec.run_id, run_item_id, repr(exc), summary_lock
            )
            return

        if succeeded or not _is_retryable(error_type) or attempt >= max_attempts:
            return

        # Backoff is interruptible: cancellation wakes it immediately.
        await _interruptible_backoff(attempt, error_type, cancel_event)


async def _execute_one_cell(
    db: AsyncSession,
    spec: _MatrixRunSpec,
    cell: _MatrixCell,
    matrix_item: RunItemORM,
) -> None:
    template = cell.variant.request_template
    mapped_sample = apply_sample_mapping(
        cell.sample, cell.variant.variable_mapping, cell.variant.image_role_mapping
    )
    if template.image_slot_specs:
        mapped_sample = map_sample_images_to_prompt_slots(mapped_sample, template.image_slot_specs)
    run_name = (
        f"Compare item: {cell.sample.sample_id} × {cell.variant.label}"
        if cell.variant.has_axes
        else f"Batch item: {cell.sample.sample_id}"
    )
    request = LabRunRequest(
        sample=mapped_sample,
        prompt=template.prompt,
        model_config=template.model_config,
        output_contract=template.output_contract,
        pricing=template.pricing,
        api_base_url=template.api_base_url,
        run_name=run_name,
        provider_config_id=template.provider_config_id,
        image_resolution_enabled=template.image_resolution_enabled,
        image_resolution_target=template.image_resolution_target,
        image_slot_specs=template.image_slot_specs,
        variable_specs=template.variable_specs,
    )

    matrix_item.status = RunItemType.RUNNING.value
    matrix_item.started_at = utc_now().isoformat()
    await db.flush()

    lab_session = await execute_lab_run(db, request, stream_callback=None)
    temp_run_id = lab_session.run_id

    result = await db.execute(select(RunItemORM).where(RunItemORM.run_id == temp_run_id))
    temp_item = result.scalar_one()
    _copy_item_result(temp_item, matrix_item, spec.run_id)
    if cell.variant.has_axes:
        matrix_item.compare_axes = _compute_axes(cell)

    attempts_result = await db.execute(
        select(AttemptORM).where(AttemptORM.run_item_id == temp_item.run_item_id)
    )
    for attempt in attempts_result.scalars().all():
        attempt.run_item_id = matrix_item.run_item_id

    await db.execute(delete(RunItemORM).where(RunItemORM.run_item_id == temp_item.run_item_id))
    await db.execute(delete(RunSessionORM).where(RunSessionORM.run_id == temp_run_id))
    await db.flush()


def _compute_axes(cell: _MatrixCell) -> dict[str, str | None] | None:
    """Return compare_axes dict for compare runs, None for batch."""
    if not cell.variant.has_axes:
        return None
    request = cell.variant.request_template
    return {
        "sample_id": cell.sample.sample_id,
        "task_id": cell.variant.task_id,
        "task_version_id": cell.variant.task_version_id,
        "prompt_id": cell.variant.prompt_id,
        "prompt_version_id": cell.variant.prompt_version_id,
        "provider_config_id": request.provider_config_id,
        "model_id": request.model_config.model_id,
        "config_label": cell.variant.label,
        "model_config_id": request.model_config.model_config_id,
    }


async def _create_pending_cell_item(db: AsyncSession, run_id: str, cell: _MatrixCell) -> RunItemORM:
    axes = _compute_axes(cell)
    item = RunItemORM(
        run_item_id=f"ritem_{uuid4().hex[:16]}",
        run_id=run_id,
        sample_id=cell.sample.sample_id,
        status=RunItemType.PENDING.value,
        compare_axes=axes,  # None for batch, dict for compare
    )
    db.add(item)
    await db.flush()
    return item


def _cell_lookup_key(cell: _MatrixCell) -> tuple:
    """Stable key for matching a cell to its RunItemORM during cancellation."""
    if cell.variant.has_axes:
        return (cell.sample.sample_id, cell.variant.task_version_id, cell.variant.label)
    return (cell.sample.sample_id,)


def _item_lookup_key(item: RunItemORM, has_axes: bool) -> tuple:
    """Extract the same key shape from an existing RunItemORM."""
    if has_axes:
        axes = item.compare_axes or {}
        return (
            axes.get("sample_id") or item.sample_id,
            axes.get("task_version_id"),
            axes.get("config_label"),
        )
    return (item.sample_id,)


async def _cancel_unfinished(
    db: AsyncSession,
    run_id: str,
    cells: list[_MatrixCell],
) -> None:
    has_axes = cells[0].variant.has_axes if cells else False
    existing_result = await db.execute(select(RunItemORM).where(RunItemORM.run_id == run_id))
    existing_by_key = {
        _item_lookup_key(item, has_axes): item
        for item in existing_result.scalars().all()
    }
    now = utc_now().isoformat()
    for cell in cells:
        key = _cell_lookup_key(cell)
        item = existing_by_key.get(key)
        if item is None:
            item = RunItemORM(
                run_item_id=f"ritem_{uuid4().hex[:16]}",
                run_id=run_id,
                sample_id=cell.sample.sample_id,
                status=RunItemType.CANCELLED.value,
                completed_at=now,
                compare_axes=_compute_axes(cell),
            )
            db.add(item)
        elif item.status in {RunItemType.PENDING.value, RunItemType.RUNNING.value}:
            item.status = RunItemType.CANCELLED.value
            item.completed_at = now
            item.updated_at = now
    await db.flush()


def _error_type(error: dict | None) -> str | None:
    if isinstance(error, dict):
        value = error.get("type")
        return str(value) if value else None
    return None


def _is_retryable(error_type: str | None) -> bool:
    return error_type in _RETRYABLE_ERROR_TYPES


async def _interruptible_backoff(
    attempt: int,
    error_type: str | None,
    cancel_event: asyncio.Event,
) -> None:
    base = _BACKOFF_BASE_SECONDS.get(error_type or "", 1.0)
    delay = min(base * (2 ** (attempt - 1)), _BACKOFF_MAX_SECONDS)
    delay += random.uniform(0, _BACKOFF_JITTER_SECONDS)
    with contextlib.suppress(asyncio.TimeoutError):
        await asyncio.wait_for(cancel_event.wait(), timeout=delay)


async def _record_unexpected_failure(
    factory: async_sessionmaker[AsyncSession],
    run_id: str,
    run_item_id: str,
    message: str,
    summary_lock: asyncio.Lock,
) -> None:
    try:
        async with factory() as db:
            await _mark_item_failed(db, run_item_id, message)
            async with summary_lock:
                await _refresh_session_summary(db, run_id)
                await db.commit()
    except Exception:
        # Best-effort; the final recompute still accounts for this item.
        return


async def _mark_item_failed(db: AsyncSession, run_item_id: str, message: str) -> None:
    result = await db.execute(select(RunItemORM).where(RunItemORM.run_item_id == run_item_id))
    item = result.scalar_one_or_none()
    if item is None:
        return
    item.status = RunItemType.FAILED.value
    item.completed_at = utc_now().isoformat()
    item.error = {"type": "unknown_error", "message": message, "retryable": False}


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


def _cleanup_task(run_id: str) -> None:
    _running_tasks.pop(run_id, None)
    _cancel_events.pop(run_id, None)

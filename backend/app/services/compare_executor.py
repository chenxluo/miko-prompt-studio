"""Sequential in-process executor for Compare Mode runs."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from uuid import uuid4

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session_factory
from app.models.run import AttemptORM, RunItemORM, RunSessionORM
from app.schemas.common import RunItemType, RunSessionStatus, RunType, utc_now
from app.schemas.model_config import ModelConfigSnapshot
from app.schemas.run_record import ConfigSnapshot, RunSource, RunSummary
from app.schemas.sample_record import SampleRecord
from app.services.batch_executor import (
    _copy_item_result,
    _mark_item_failed,
    _refresh_session_summary,
    map_sample_images_to_prompt_slots,
)
from app.services.request_builder import _pricing_snapshot
from app.services.run_executor import LabRunRequest, _make_prompt_snapshot, execute_lab_run
from app.services.sample_mapping import apply_sample_mapping


@dataclass(frozen=True)
class VariantSpec:
    label: str
    request_template: LabRunRequest
    task_id: str
    task_version_id: str
    prompt_id: str | None = None
    prompt_version_id: str | None = None
    variable_mapping: dict[str, str] = field(default_factory=dict)
    image_role_mapping: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class CompareRunSpec:
    run_id: str
    name: str
    source: RunSource | dict
    samples: list[SampleRecord]
    variants: list[VariantSpec]


@dataclass(frozen=True)
class _CompareCell:
    sample: SampleRecord
    variant: VariantSpec


_running_tasks: dict[str, asyncio.Task] = {}
_cancel_events: dict[str, asyncio.Event] = {}


async def start_compare_run(spec: CompareRunSpec) -> str:
    """Create the compare session row and start a background worker."""

    cancel_event = asyncio.Event()
    _cancel_events[spec.run_id] = cancel_event

    factory = get_session_factory()
    async with factory() as db:
        await _create_session(db, spec)
        await db.commit()

    task = asyncio.create_task(_run_compare_worker(spec, cancel_event))
    _running_tasks[spec.run_id] = task
    task.add_done_callback(lambda _task: _cleanup_task(spec.run_id))
    return spec.run_id


def request_compare_cancel(run_id: str) -> bool:
    """Signal cancellation for a running compare task."""

    event = _cancel_events.get(run_id)
    task = _running_tasks.get(run_id)
    found = event is not None or task is not None
    if event is not None:
        event.set()
    if task is not None and not task.done():
        task.cancel()
    return found


async def _create_session(db: AsyncSession, spec: CompareRunSpec) -> None:
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
    session = RunSessionORM(
        run_id=spec.run_id,
        run_type=RunType.COMPARE.value,
        name=spec.name or f"Compare: {len(spec.samples)} samples × {len(spec.variants)} variants",
        status=RunSessionStatus.RUNNING.value,
        started_at=utc_now().isoformat(),
        source=(
            spec.source.model_dump(mode="json")
            if isinstance(spec.source, RunSource)
            else spec.source
        ),
        config_snapshot=config_snapshot.model_dump(mode="json"),
        summary=RunSummary(total_items=total_items, currency=currency).model_dump(mode="json"),
    )
    db.add(session)
    await db.flush()


async def _run_compare_worker(spec: CompareRunSpec, cancel_event: asyncio.Event) -> None:
    cells = [
        _CompareCell(sample=sample, variant=variant)
        for sample in spec.samples
        for variant in spec.variants
    ]
    factory = get_session_factory()
    need_cancel_cleanup = False
    async with factory() as db:
        try:
            for index, cell in enumerate(cells):
                if cancel_event.is_set():
                    await _cancel_unfinished(db, spec.run_id, cells[index:])
                    await _refresh_session_summary(
                        db,
                        spec.run_id,
                        final_status=RunSessionStatus.CANCELLED.value,
                    )
                    await db.commit()
                    return

                item = await _create_pending_item(db, spec.run_id, cell)
                await db.commit()

                try:
                    await _execute_one_item(db, spec, cell, item)
                    await _refresh_session_summary(db, spec.run_id)
                    await db.commit()
                except asyncio.CancelledError:
                    # Defer finalization to after this session is released, so
                    # the cleanup write doesn't race the still-open session's
                    # SQLite write lock ("database is locked" under WAL).
                    cancel_event.set()
                    raise
                except Exception as exc:
                    await db.rollback()
                    async with factory() as error_db:
                        await _mark_item_failed(error_db, item.run_item_id, str(exc))
                        await _refresh_session_summary(error_db, spec.run_id)
                        await error_db.commit()

                if cancel_event.is_set():
                    await _cancel_unfinished(db, spec.run_id, cells[index + 1 :])
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
            # Don't finalize inside `async with db`: opening a second session
            # here deadlocks SQLite. Let the session close (rolling back the
            # in-flight transaction), then finalize with a fresh connection.
            cancel_event.set()
            need_cancel_cleanup = True

    if need_cancel_cleanup:
        async with factory() as cancel_db:
            await _cancel_unfinished(cancel_db, spec.run_id, cells)
            await _refresh_session_summary(
                cancel_db,
                spec.run_id,
                final_status=RunSessionStatus.CANCELLED.value,
            )
            await cancel_db.commit()


async def _create_pending_item(
    db: AsyncSession,
    run_id: str,
    cell: _CompareCell,
) -> RunItemORM:
    item = RunItemORM(
        run_item_id=f"ritem_{uuid4().hex[:16]}",
        run_id=run_id,
        sample_id=cell.sample.sample_id,
        status=RunItemType.PENDING.value,
        compare_axes=_compare_axes(cell),
    )
    db.add(item)
    await db.flush()
    return item


async def _execute_one_item(
    db: AsyncSession,
    spec: CompareRunSpec,
    cell: _CompareCell,
    compare_item: RunItemORM,
) -> None:
    template = cell.variant.request_template
    mapped_sample = apply_sample_mapping(
        cell.sample, cell.variant.variable_mapping, cell.variant.image_role_mapping
    )
    if template.image_slot_specs:
        mapped_sample = map_sample_images_to_prompt_slots(mapped_sample, template.image_slot_specs)
    request = LabRunRequest(
        sample=mapped_sample,
        prompt=template.prompt,
        model_config=template.model_config,
        output_contract=template.output_contract,
        pricing=template.pricing,
        api_base_url=template.api_base_url,
        run_name=f"Compare item: {cell.sample.sample_id} × {cell.variant.label}",
        provider_config_id=template.provider_config_id,
        image_resolution_enabled=template.image_resolution_enabled,
        image_resolution_target=template.image_resolution_target,
        image_slot_specs=template.image_slot_specs,
        variable_specs=template.variable_specs,
    )

    compare_item.status = RunItemType.RUNNING.value
    compare_item.started_at = utc_now().isoformat()
    await db.flush()

    lab_session = await execute_lab_run(db, request, stream_callback=None)
    temp_run_id = lab_session.run_id

    result = await db.execute(select(RunItemORM).where(RunItemORM.run_id == temp_run_id))
    temp_item = result.scalar_one()
    _copy_item_result(temp_item, compare_item, spec.run_id)
    compare_item.compare_axes = _compare_axes(cell)

    attempts_result = await db.execute(
        select(AttemptORM).where(AttemptORM.run_item_id == temp_item.run_item_id)
    )
    for attempt in attempts_result.scalars().all():
        attempt.run_item_id = compare_item.run_item_id

    await db.execute(delete(RunItemORM).where(RunItemORM.run_item_id == temp_item.run_item_id))
    await db.execute(delete(RunSessionORM).where(RunSessionORM.run_id == temp_run_id))
    await db.flush()


def _compare_axes(cell: _CompareCell) -> dict[str, str | None]:
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


async def _cancel_unfinished(
    db: AsyncSession,
    run_id: str,
    cells: list[_CompareCell],
) -> None:
    existing_result = await db.execute(select(RunItemORM).where(RunItemORM.run_id == run_id))
    existing_by_axis = {
        (
            (item.compare_axes or {}).get("sample_id") or item.sample_id,
            (item.compare_axes or {}).get("task_version_id"),
            (item.compare_axes or {}).get("config_label"),
        ): item
        for item in existing_result.scalars().all()
    }
    now = utc_now().isoformat()
    for cell in cells:
        key = (cell.sample.sample_id, cell.variant.task_version_id, cell.variant.label)
        item = existing_by_axis.get(key)
        if item is None:
            item = RunItemORM(
                run_item_id=f"ritem_{uuid4().hex[:16]}",
                run_id=run_id,
                sample_id=cell.sample.sample_id,
                status=RunItemType.CANCELLED.value,
                completed_at=now,
                compare_axes=_compare_axes(cell),
            )
            db.add(item)
        elif item.status in {RunItemType.PENDING.value, RunItemType.RUNNING.value}:
            item.status = RunItemType.CANCELLED.value
            item.completed_at = now
            item.updated_at = now
    await db.flush()


def _cleanup_task(run_id: str) -> None:
    _running_tasks.pop(run_id, None)
    _cancel_events.pop(run_id, None)

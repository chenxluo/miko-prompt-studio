"""Derive new sample sets from completed runs (routing / composition / chaining)."""

from __future__ import annotations

import copy
from typing import Any
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.run import RunItemORM, RunSessionORM
from app.models.sample import SampleRecordORM, SampleSetORM
from app.schemas.common import RunSessionStatus
from app.schemas.sample_record import SampleRecord
from app.services.filter_eval import FilterError, apply_filter, build_item_context


class DeriveError(Exception):
    """Raised when a sample-set derivation fails in a way the CLI should report."""

    def __init__(self, message: str, exit_code: int = 65) -> None:
        self.exit_code = exit_code
        self.message = message
        super().__init__(message)


async def derive_sample_set_from_run(
    session: AsyncSession,
    run_id: str,
    *,
    name: str,
    filter_expr: str | None = None,
    carry_response: str | None = None,
    drop_original: bool = False,
    task_version_id: str | None = None,
) -> SampleSetORM:
    """Create a new ``SampleSet`` whose records are derived from a finished run.

    Default behaviour (no flags) carries the original sample record (vars +
    images) into the new set — the routing case.  ``carry_response`` adds the
    upstream item response as a variable, and ``drop_original`` discards the
    original input so the upstream response becomes the sole input (chaining).
    """
    run = await session.execute(
        select(RunSessionORM).where(RunSessionORM.run_id == run_id)
    )
    run_session = run.scalar_one_or_none()
    if run_session is None:
        raise DeriveError(f"Run '{run_id}' not found.", exit_code=67)

    if run_session.status not in {
        RunSessionStatus.COMPLETED.value,
        RunSessionStatus.COMPLETED_WITH_ERRORS.value,
    }:
        raise DeriveError(
            f"Run '{run_id}' has not finished (status={run_session.status}). "
            f"Use `mps run get {run_id}` to check.",
            exit_code=65,
        )

    items_result = await session.execute(
        select(RunItemORM).where(RunItemORM.run_id == run_id)
    )
    items = list(items_result.scalars().all())

    contexts = [build_item_context(item) for item in items]
    if filter_expr:
        try:
            contexts = apply_filter(contexts, filter_expr)
        except FilterError as exc:
            raise DeriveError(str(exc), exit_code=65) from exc

    surviving_context_ids = {id(ctx) for ctx in contexts}
    surviving_items = [
        item
        for ctx, item in zip(contexts, items, strict=False)
        if id(ctx) in surviving_context_ids
    ]

    # Find the original sample set so we can look up records by (set, sample_id)
    # rather than the non-unique sample_id alone.
    source = run_session.source or {}
    source_sample_set_id = source.get("sample_set_id")

    new_records: list[SampleRecord] = []
    for item in surviving_items:
        original = await _load_original_sample(
            session, item.sample_id, source_sample_set_id
        )
        if original is None:
            # Should be rare; skip rather than abort the whole operation.
            continue

        new_sample_id = f"sr_{uuid4().hex[:12]}"
        new_record = SampleRecord.model_validate(original.data)
        new_record.sample_id = new_sample_id
        new_record.sample_set_id = None

        if drop_original:
            new_record.vars = {}
            new_record.images = []
        else:
            new_record.vars = copy.deepcopy(new_record.vars)
            new_record.images = copy.deepcopy(new_record.images)
            new_record.metadata = copy.deepcopy(new_record.metadata or {})
            new_record.tags = copy.deepcopy(new_record.tags)
            new_record.notes = copy.deepcopy(new_record.notes)

        if carry_response:
            carried = _extract_response_value(item)
            new_record.vars[carry_response] = copy.deepcopy(carried)

        new_records.append(new_record)

    from app.main import _persist_sample_records

    try:
        sample_set_id = await _persist_sample_records(
            session,
            new_records,
            name=name,
            import_source={
                "type": "from-run",
                "run_id": run_id,
                "filter_expr": filter_expr,
                "carry_response": carry_response,
                "drop_original": drop_original,
                "task_version_id": task_version_id,
            },
        )
    except IntegrityError as exc:
        raise DeriveError(
            f"A sample set named '{name}' already exists.", exit_code=73
        ) from exc

    sset_result = await session.execute(
        select(SampleSetORM).where(SampleSetORM.sample_set_id == sample_set_id)
    )
    sset = sset_result.scalar_one()
    return sset


async def _load_original_sample(
    session: AsyncSession,
    sample_id: str,
    sample_set_id: str | None,
) -> SampleRecordORM | None:
    """Load the original sample record that produced a run item."""
    stmt = select(SampleRecordORM).where(SampleRecordORM.sample_id == sample_id)
    if sample_set_id:
        stmt = stmt.where(SampleRecordORM.sample_set_id == sample_set_id)
    result = await session.execute(stmt)
    return result.scalar_one_or_none()


def _extract_response_value(item: RunItemORM) -> Any:
    """Pick the best representation of a run item response for downstream use."""
    response = item.response or {}
    if not isinstance(response, dict):
        return None
    parsed = response.get("parsed")
    if parsed is not None and isinstance(parsed, dict):
        return parsed
    raw_text = response.get("raw_text")
    if raw_text is not None:
        return raw_text
    return None

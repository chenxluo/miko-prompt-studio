"""Shared query for cost/usage aggregation across a task version's runs.

Both the ``/cost-stats`` endpoint and the task-doc usage stats need the same
thing: the succeeded run items attributable to a given task version. They used
to duplicate the filter, and both excluded compare runs — so a version
exercised only via compare had no cost estimate. Centralizing the attribution
here keeps the two in sync and closes that gap.
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.run import RunItemORM, RunSessionORM
from app.schemas.common import RunItemType, RunSessionStatus, RunType

_COMPLETED_STATUSES = [
    RunSessionStatus.COMPLETED.value,
    RunSessionStatus.COMPLETED_WITH_ERRORS.value,
]
_SUCCEEDED_STATUSES = [RunItemType.SUCCEEDED.value, "completed"]


async def collect_version_run_items(
    db: AsyncSession, task_version_id: str
) -> list[RunItemORM]:
    """Succeeded ``RunItem``s whose effective task version is ``task_version_id``.

    Attribution differs by run type:

    * **batch / lab** runs carry one version at the session level
      (``source.task_version_id``) — every succeeded item in a matching run
      counts.
    * **compare** runs span several versions; the version lives per-item in
      ``compare_axes.task_version_id`` (and the involved versions are listed in
      ``source.variants[]``). Only the items pointing at the requested version
      are returned, so a compare run never leaks another variant's cost in.
    """
    sessions_result = await db.execute(
        select(RunSessionORM).where(RunSessionORM.status.in_(_COMPLETED_STATUSES))
    )
    batch_run_ids: list[str] = []
    compare_run_ids: list[str] = []
    for session in sessions_result.scalars().all():
        source = session.source or {}
        if session.run_type == RunType.COMPARE.value:
            variants = source.get("variants") or []
            if any(v.get("task_version_id") == task_version_id for v in variants):
                compare_run_ids.append(session.run_id)
        elif source.get("task_version_id") == task_version_id:
            batch_run_ids.append(session.run_id)

    run_ids = batch_run_ids + compare_run_ids
    if not run_ids:
        return []

    items_result = await db.execute(
        select(RunItemORM).where(
            RunItemORM.run_id.in_(run_ids),
            RunItemORM.status.in_(_SUCCEEDED_STATUSES),
        )
    )
    # Compare items must be attributed per-item; batch/lab items belong to the
    # version via their run and have no compare_axes.
    compare_run_set = set(compare_run_ids)
    return [
        item
        for item in items_result.scalars().all()
        if item.run_id not in compare_run_set
        or (item.compare_axes or {}).get("task_version_id") == task_version_id
    ]

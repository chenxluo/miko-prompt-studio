"""Reference resolver for CLI-friendly task/sample-set identifiers.

Accepts task references such as:
  - task_<id>
  - tv_<id>
  - <name>
  - <name>@latest
  - <name>@vN
  - <name>@tv_<id>

and sample-set references such as:
  - sset_<id>
  - <name>
"""

from __future__ import annotations

import difflib
import re

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.sample import SampleSetORM
from app.models.task import TaskORM, TaskVersionORM


class RefResolutionError(Exception):
    """Raised when a task or sample-set reference cannot be resolved."""

    def __init__(self, ref: str, message: str, suggestions: list[str] | None = None) -> None:
        self.ref = ref
        self.message = message
        self.suggestions = list(suggestions or [])
        hint = ""
        if self.suggestions:
            hint = f" Did you mean: {', '.join(self.suggestions)}?"
        super().__init__(f"cannot resolve '{ref}': {message}{hint}")

    def __str__(self) -> str:
        return self.args[0]


async def _task_candidates(session: AsyncSession) -> list[tuple[str, str]]:
    """Return (task_id, name) for all tasks."""
    result = await session.execute(select(TaskORM.task_id, TaskORM.name))
    return [(row.task_id, row.name) for row in result.all()]


async def _sset_candidates(session: AsyncSession) -> list[tuple[str, str]]:
    """Return (sample_set_id, name) for all sample sets."""
    result = await session.execute(select(SampleSetORM.sample_set_id, SampleSetORM.name))
    return [(row.sample_set_id, row.name) for row in result.all()]


def _suggest(ref: str, candidates: list[str], n: int = 3) -> list[str]:
    matches = difflib.get_close_matches(ref, candidates, n=n, cutoff=0.6)
    return list(matches)


async def _load_task_by_id(session: AsyncSession, task_id: str) -> TaskORM | None:
    result = await session.execute(select(TaskORM).where(TaskORM.task_id == task_id))
    return result.scalar_one_or_none()


async def _load_task_by_name(session: AsyncSession, name: str) -> TaskORM | None:
    result = await session.execute(select(TaskORM).where(TaskORM.name == name))
    return result.scalar_one_or_none()


async def _load_version_by_id(session: AsyncSession, task_version_id: str) -> TaskVersionORM | None:
    result = await session.execute(
        select(TaskVersionORM).where(TaskVersionORM.task_version_id == task_version_id)
    )
    return result.scalar_one_or_none()


async def _load_version_by_label(
    session: AsyncSession, task_id: str, version_label: str
) -> TaskVersionORM | None:
    result = await session.execute(
        select(TaskVersionORM).where(
            TaskVersionORM.task_id == task_id,
            TaskVersionORM.version_label == version_label,
        )
    )
    return result.scalar_one_or_none()


async def _load_sset_by_id(session: AsyncSession, sample_set_id: str) -> SampleSetORM | None:
    result = await session.execute(
        select(SampleSetORM).where(SampleSetORM.sample_set_id == sample_set_id)
    )
    return result.scalar_one_or_none()


async def _load_sset_by_name(session: AsyncSession, name: str) -> SampleSetORM | None:
    result = await session.execute(select(SampleSetORM).where(SampleSetORM.name == name))
    return result.scalar_one_or_none()


async def _task_suggestions(session: AsyncSession, ref: str) -> list[str]:
    candidates: list[str] = []
    for task_id, name in await _task_candidates(session):
        candidates.append(task_id)
        if name:
            candidates.append(name)
    return _suggest(ref, candidates)


async def _sset_suggestions(session: AsyncSession, ref: str) -> list[str]:
    candidates: list[str] = []
    for sample_set_id, name in await _sset_candidates(session):
        candidates.append(sample_set_id)
        if name:
            candidates.append(name)
    return _suggest(ref, candidates)


async def resolve_task_ref(
    session: AsyncSession, ref: str
) -> tuple[TaskORM, TaskVersionORM]:
    """Resolve a task reference to (task, version).

    Accepted forms:
      - 'task_<id>'  -> task by id, uses its current_version
      - 'tv_<id>'    -> version by id, returns (its task, that version)
      - 'name'       -> task by unique name, uses current_version
      - 'name@latest'-> same as bare name (explicit)
      - 'name@vN'    -> task by name, version where version_label == 'vN'
      - 'name@tv_<id>' -> task by name (validation), specific version
    """
    if not ref:
        raise RefResolutionError(ref, "reference is empty")

    # 1. tv_<id> -> version by id
    if ref.startswith("tv_"):
        version = await _load_version_by_id(session, ref)
        if version is None:
            suggestions = await _task_suggestions(session, ref)
            raise RefResolutionError(ref, "task version not found", suggestions)
        task = await _load_task_by_id(session, version.task_id)
        if task is None:
            raise RefResolutionError(ref, "task version exists but its task is missing")
        return task, version

    # 2. task_<id> -> task by id
    if ref.startswith("task_"):
        task = await _load_task_by_id(session, ref)
        if task is None:
            suggestions = await _task_suggestions(session, ref)
            raise RefResolutionError(ref, "task not found", suggestions)
        if not task.current_version_id:
            raise RefResolutionError(ref, "task has no current version")
        version = await _load_version_by_id(session, task.current_version_id)
        if version is None:
            raise RefResolutionError(ref, "task has no current version")
        return task, version

    # 4. name@suffix (split on FIRST '@')
    if "@" in ref:
        name, suffix = ref.split("@", 1)
        if not name:
            raise RefResolutionError(ref, "missing task name before '@'")
        task = await _load_task_by_name(session, name)
        if task is None:
            suggestions = await _task_suggestions(session, name)
            raise RefResolutionError(ref, f"task name '{name}' not found", suggestions)

        version: TaskVersionORM | None
        if suffix == "latest":
            version = (
                await _load_version_by_id(session, task.current_version_id)
                if task.current_version_id
                else None
            )
        elif suffix.startswith("tv_"):
            version = await _load_version_by_id(session, suffix)
            if version is None or version.task_id != task.task_id:
                raise RefResolutionError(ref, f"version '{suffix}' not found for this task")
        elif re.fullmatch(r"v\d+", suffix) or suffix:
            # any version_label (including vN or other labels)
            version = await _load_version_by_label(session, task.task_id, suffix)
        else:
            version = None

        if version is None:
            raise RefResolutionError(ref, f"version '{suffix}' not found for this task")
        return task, version

    # 5. bare name
    task = await _load_task_by_name(session, ref)
    if task is None:
        suggestions = await _task_suggestions(session, ref)
        raise RefResolutionError(ref, "task not found", suggestions)
    if not task.current_version_id:
        raise RefResolutionError(ref, "task has no current version")
    version = await _load_version_by_id(session, task.current_version_id)
    if version is None:
        raise RefResolutionError(ref, "task has no current version")
    return task, version


async def resolve_sset_ref(session: AsyncSession, ref: str) -> SampleSetORM:
    """Resolve a sample-set reference.

    Accepted forms:
      - 'ss_<id>' (actual database prefix)
      - 'sset_<id>' (alias accepted by the resolver)
      - 'name'
    """
    if not ref:
        raise RefResolutionError(ref, "reference is empty")

    # 3. ss_<id> / sset_<id> (actual DB prefix is ss_; sset_ is an alias)
    if ref.startswith("ss_") or ref.startswith("sset_"):
        lookup_id = ref
        if ref.startswith("sset_"):
            lookup_id = ref.replace("sset_", "ss_", 1)
        sset = await _load_sset_by_id(session, lookup_id)
        if sset is None:
            suggestions = await _sset_suggestions(session, ref)
            raise RefResolutionError(ref, "sample set not found", suggestions)
        return sset

    # 5. bare name
    sset = await _load_sset_by_name(session, ref)
    if sset is None:
        suggestions = await _sset_suggestions(session, ref)
        raise RefResolutionError(ref, "sample set not found", suggestions)
    return sset


async def resolve_version_ref(
    session: AsyncSession, task_ref: str | None, version_ref: str
) -> tuple[TaskORM, TaskVersionORM]:
    """Resolve a version reference within a known task context.

    ``version_ref`` may be:
      - 'tv_<id>' (resolved within the task context when one is provided)
      - 'name@vN' / 'name@tv_<id>' / 'name@latest' (resolved via resolve_task_ref)
      - 'task_<id>' / 'task_<id>@vN' etc.
      - bare 'vN' (requires ``task_ref`` to provide the task context)
    """
    if not version_ref:
        raise RefResolutionError(version_ref, "version reference is empty")

    async def _expect_same_task(resolved_task: TaskORM) -> None:
        if task_ref is None:
            return
        expected, _ = await resolve_task_ref(session, task_ref)
        if resolved_task.task_id != expected.task_id:
            raise RefResolutionError(
                version_ref,
                f"version reference does not belong to task '{expected.name or expected.task_id}'",
            )

    # Full references that already encode their own task/version context.
    if "@" in version_ref or version_ref.startswith("task_"):
        resolved = await resolve_task_ref(session, version_ref)
        await _expect_same_task(resolved[0])
        return resolved

    if version_ref.startswith("tv_"):
        version = await _load_version_by_id(session, version_ref)
        if version is None:
            if task_ref is not None:
                expected, _ = await resolve_task_ref(session, task_ref)
                result = await session.execute(
                    select(TaskVersionORM.task_version_id).where(
                        TaskVersionORM.task_id == expected.task_id
                    )
                )
                candidates = [row.task_version_id for row in result.all()]
                suggestions = _suggest(version_ref, candidates)
                raise RefResolutionError(
                    version_ref, "version not found for this task", suggestions
                )
            suggestions = await _task_suggestions(session, version_ref)
            raise RefResolutionError(version_ref, "task version not found", suggestions)
        if task_ref is not None:
            expected, _ = await resolve_task_ref(session, task_ref)
            if version.task_id != expected.task_id:
                raise RefResolutionError(
                    version_ref,
                    f"version does not belong to task '{expected.name or expected.task_id}'",
                )
            return expected, version
        task = await _load_task_by_id(session, version.task_id)
        if task is None:
            raise RefResolutionError(version_ref, "version exists but its task is missing")
        return task, version

    # Bare version label (e.g. vN) needs a task context.
    if task_ref is None:
        raise RefResolutionError(
            version_ref,
            "a bare version label requires a task context; use name@vN or tv_<id>",
        )

    task, _ = await resolve_task_ref(session, task_ref)
    version = await _load_version_by_label(session, task.task_id, version_ref)
    if version is None:
        result = await session.execute(
            select(TaskVersionORM.task_version_id, TaskVersionORM.version_label).where(
                TaskVersionORM.task_id == task.task_id
            )
        )
        candidates: list[str] = []
        for row in result.all():
            candidates.append(row.task_version_id)
            candidates.append(row.version_label)
        suggestions = _suggest(version_ref, candidates)
        raise RefResolutionError(
            version_ref, f"version '{version_ref}' not found for this task", suggestions
        )
    return task, version

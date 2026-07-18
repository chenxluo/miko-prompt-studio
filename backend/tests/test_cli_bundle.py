"""Integration tests for the ``mps export`` / ``mps import`` CLI commands."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from uuid import uuid4

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _reset(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("MIKO_DATA_DIR", str(tmp_path))
    import app.config as config
    import app.database as database

    config._settings = None
    database._engine = None
    database._session_factory = None


async def _seed_task(name: str = "CLI Task") -> str:
    from app.database import init_db, session_scope
    from app.models.provider_config import ProviderConfigORM
    from app.models.task import TaskORM, TaskVersionORM

    await init_db()
    async with session_scope() as db:
        pc = ProviderConfigORM(
            provider_config_id=f"pc_{uuid4().hex[:12]}",
            name="p",
            adapter_id="openai",
        )
        t = TaskORM(
            task_id=f"task_{uuid4().hex[:12]}",
            name=name,
            tags=["x"],
            created_at="2024-01-01T00:00:00+00:00",
            updated_at="2024-01-01T00:00:00+00:00",
        )
        db.add_all([pc, t])
        await db.flush()
        v = TaskVersionORM(
            task_version_id=f"tv_{uuid4().hex[:12]}",
            task_id=t.task_id,
            version_label="v1",
            model_id="m",
            system_prompt="SP",
            user_template="UT {{x}}",
            provider_config_id=pc.provider_config_id,
            created_at="2024-01-01T00:00:00+00:00",
            updated_at="2024-01-01T00:00:00+00:00",
        )
        db.add(v)
        t.current_version_id = v.task_version_id
        return t.task_id


async def _seed_and_export(task_name: str, out_path: Path) -> str:
    from app import cli
    from app.database import get_engine

    task_id = await _seed_task(task_name)
    engine = get_engine()
    try:
        await cli._amain(["export", "--task", task_id, "-o", str(out_path)])
    finally:
        await engine.dispose()
    return task_id


async def _import_and_verify(out_path: Path, expected_count: int) -> None:
    from sqlalchemy import select

    from app import cli
    from app.database import get_engine, init_db, session_scope
    from app.models.task import TaskORM

    await cli._amain(["import", str(out_path)])
    await init_db()
    async with session_scope() as db:
        tasks = (await db.execute(select(TaskORM))).scalars().all()
        assert len(tasks) == expected_count
        if expected_count == 1:
            assert tasks[0].name == "CLI Task"
    await get_engine().dispose()


async def _import_dry_run_and_verify(out_path: Path) -> None:
    from sqlalchemy import select

    from app import cli
    from app.database import get_engine, init_db, session_scope
    from app.models.task import TaskORM

    await cli._amain(["import", str(out_path), "--dry-run"])
    await init_db()
    async with session_scope() as db:
        tasks = (await db.execute(select(TaskORM))).scalars().all()
        assert len(tasks) == 0
    await get_engine().dispose()


async def _export_without_scope(out_path: Path) -> None:
    from app import cli
    from app.database import get_engine

    engine = get_engine()
    try:
        await cli._amain(["export", "-o", str(out_path)])
    finally:
        await engine.dispose()


def test_cli_export_then_import(tmp_path, monkeypatch):
    _reset(tmp_path / "a", monkeypatch)
    out_path = tmp_path / "a" / "bundle.mikobundle"
    asyncio.run(_seed_and_export("CLI Task", out_path))
    assert out_path.exists()

    _reset(tmp_path / "b", monkeypatch)
    asyncio.run(_import_and_verify(out_path, expected_count=1))


def test_cli_import_dry_run_does_not_write(tmp_path, monkeypatch):
    _reset(tmp_path / "a", monkeypatch)
    out_path = tmp_path / "a" / "bundle.mikobundle"
    asyncio.run(_seed_and_export("CLI Task", out_path))

    _reset(tmp_path / "b", monkeypatch)
    asyncio.run(_import_dry_run_and_verify(out_path))


def test_cli_export_requires_scope(tmp_path, monkeypatch):
    _reset(tmp_path, monkeypatch)
    out_path = tmp_path / "out.mikobundle"
    with pytest.raises(ValueError, match="no export scope given"):
        asyncio.run(_export_without_scope(out_path))

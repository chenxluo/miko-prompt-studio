"""Tests for the portable bundle export/import engine."""

from __future__ import annotations

import asyncio
import sys
import uuid
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _reset_singletons(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("MIKO_DATA_DIR", str(tmp_path))
    import app.config as config
    import app.database as database

    config._settings = None
    database._engine = None
    database._session_factory = None


async def _dispose_engine() -> None:
    from app.database import get_engine

    engine = get_engine()
    await engine.dispose()


async def _seed_task_round_trip() -> str:
    from app.database import init_db, session_scope
    from app.models.provider_config import ProviderConfigORM
    from app.models.task import TaskORM, TaskVersionORM

    await init_db()
    async with session_scope() as db:
        pc = ProviderConfigORM(
            provider_config_id=f"pc_{uuid.uuid4().hex[:12]}",
            name="Round-Trip Provider",
            adapter_id="openai",
            base_url="http://localhost:1234/v1",
            api_key_encrypted="sk-secret",
            cached_models=["gpt-4"],
            selected_models=["gpt-4"],
            notes="",
            created_at="2024-01-01T00:00:00+00:00",
            updated_at="2024-01-01T00:00:00+00:00",
        )
        tv = TaskVersionORM(
            task_version_id=f"tv_{uuid.uuid4().hex[:12]}",
            task_id=f"task_{uuid.uuid4().hex[:12]}",
            version_label="v1",
            system_prompt="system prompt",
            user_template="user {{x}}",
            provider_config_id=pc.provider_config_id,
            model_id="gpt-4",
            model_parameters={"temperature": 0.2},
            output_contract={"mode": "free_text"},
            notes="",
            created_at="2024-01-01T00:00:00+00:00",
            updated_at="2024-01-01T00:00:00+00:00",
        )
        task = TaskORM(
            task_id=tv.task_id,
            name="Round Trip Task",
            description="d",
            current_version_id=tv.task_version_id,
            tags=["t"],
            created_at="2024-01-01T00:00:00+00:00",
            updated_at="2024-01-01T00:00:00+00:00",
        )
        db.add(pc)
        db.add(tv)
        db.add(task)
        return task.task_id


async def _seed_task_named(name: str) -> str:
    from app.database import init_db, session_scope
    from app.models.provider_config import ProviderConfigORM
    from app.models.task import TaskORM, TaskVersionORM

    await init_db()
    async with session_scope() as db:
        pc = ProviderConfigORM(
            provider_config_id=f"pc_{uuid.uuid4().hex[:12]}",
            name="Provider",
            adapter_id="openai",
            api_key_encrypted="sk-secret",
            created_at="2024-01-01T00:00:00+00:00",
            updated_at="2024-01-01T00:00:00+00:00",
        )
        tv = TaskVersionORM(
            task_version_id=f"tv_{uuid.uuid4().hex[:12]}",
            task_id=f"task_{uuid.uuid4().hex[:12]}",
            system_prompt="sp",
            user_template="ut",
            provider_config_id=pc.provider_config_id,
            model_id="m",
            created_at="2024-01-01T00:00:00+00:00",
            updated_at="2024-01-01T00:00:00+00:00",
        )
        task = TaskORM(
            task_id=tv.task_id,
            name=name,
            current_version_id=tv.task_version_id,
            created_at="2024-01-01T00:00:00+00:00",
            updated_at="2024-01-01T00:00:00+00:00",
        )
        db.add(pc)
        db.add(tv)
        db.add(task)
        return task.task_id


async def _seed_sample_set_with_image() -> str:
    from app.config import get_settings
    from app.database import init_db, session_scope
    from app.models.sample import SampleRecordORM, SampleSetORM

    await init_db()
    async with session_scope() as db:
        settings = get_settings()
        settings.uploads_dir.mkdir(parents=True, exist_ok=True)
        img_path = settings.uploads_dir / "test.png"
        img_path.write_bytes(b"\x89PNG\r\n\x1a\n")

        sample_id = f"sr_{uuid.uuid4().hex[:12]}"
        sample_set_id = f"ss_{uuid.uuid4().hex[:12]}"
        ss = SampleSetORM(
            sample_set_id=sample_set_id,
            name="Image Sample Set",
            record_ids=[sample_id],
            created_at="2024-01-01T00:00:00+00:00",
            updated_at="2024-01-01T00:00:00+00:00",
        )
        sr = SampleRecordORM(
            sample_id=sample_id,
            sample_set_id=sample_set_id,
            sample_type="single_image",
            data={
                "schema_version": "sample_record.v1",
                "sample_id": sample_id,
                "sample_type": "single_image",
                "images": [
                    {
                        "role": "target",
                        "path": str(img_path),
                        "mime_type": "image/png",
                        "display_name": "test.png",
                        "order": 0,
                    }
                ],
            },
            created_at="2024-01-01T00:00:00+00:00",
            updated_at="2024-01-01T00:00:00+00:00",
        )
        db.add(ss)
        db.add(sr)
        return sample_set_id


async def _export(task_id: str, out_path: Path) -> dict:
    from app.database import init_db, session_scope
    from app.services.bundle import ExportOptions, ExportScope, export_to_file

    await init_db()
    async with session_scope() as db:
        summary = await export_to_file(
            db,
            ExportScope(task_ids=[task_id]),
            ExportOptions(),
            out_path,
        )
    await _dispose_engine()
    return summary


async def _export_envelope(task_id: str) -> Any:
    from app.database import init_db, session_scope
    from app.services.bundle import ExportOptions, ExportScope, export_bundle

    await init_db()
    async with session_scope() as db:
        envelope = await export_bundle(
            db,
            ExportScope(task_ids=[task_id]),
            ExportOptions(),
        )
    await _dispose_engine()
    return envelope


async def _export_sample_set(sample_set_id: str, out_path: Path) -> dict:
    from app.database import init_db, session_scope
    from app.services.bundle import ExportOptions, ExportScope, export_to_file

    await init_db()
    async with session_scope() as db:
        summary = await export_to_file(
            db,
            ExportScope(sample_set_ids=[sample_set_id]),
            ExportOptions(),
            out_path,
        )
    await _dispose_engine()
    return summary


async def _import(path: Path, options=None) -> Any:
    from app.database import init_db, session_scope
    from app.services.bundle import ImportOptions, import_bundle, read_bundle

    if options is None:
        options = ImportOptions(mode="skip")
    await init_db()
    envelope = read_bundle(path)
    async with session_scope() as db:
        report = await import_bundle(db, envelope, options)
    await _dispose_engine()
    return report


async def _verify_b() -> None:
    from sqlalchemy import select

    from app.database import init_db, session_scope
    from app.models.provider_config import ProviderConfigORM
    from app.models.task import TaskORM, TaskVersionORM

    await init_db()
    async with session_scope() as db:
        tasks = (await db.execute(select(TaskORM))).scalars().all()
        assert len(tasks) == 1
        assert tasks[0].name == "Round Trip Task"
        tvs = (await db.execute(select(TaskVersionORM))).scalars().all()
        assert len(tvs) == 1
        assert tvs[0].system_prompt == "system prompt"
        assert tvs[0].model_id == "gpt-4"
        pcs = (await db.execute(select(ProviderConfigORM))).scalars().all()
        assert len(pcs) == 1
        assert pcs[0].api_key_encrypted is None
        assert pcs[0].base_url is None
    await _dispose_engine()


async def _verify_duplicate() -> None:
    from sqlalchemy import select

    from app.database import init_db, session_scope
    from app.models.task import TaskORM, TaskVersionORM

    await init_db()
    async with session_scope() as db:
        tasks = (await db.execute(select(TaskORM))).scalars().all()
        assert len(tasks) == 2
        names = {t.name for t in tasks}
        assert "Round Trip Task" in names
        assert "Round Trip Task (imported)" in names
        original = [t for t in tasks if t.name == "Round Trip Task"][0]
        duplicated = [t for t in tasks if t.name == "Round Trip Task (imported)"][0]
        assert original.task_id != duplicated.task_id
        assert original.current_version_id != duplicated.current_version_id
        tvs = (await db.execute(select(TaskVersionORM))).scalars().all()
        assert len(tvs) == 2
    await _dispose_engine()


async def _verify_collision(expected_original_name: str) -> None:
    from sqlalchemy import select

    from app.database import init_db, session_scope
    from app.models.task import TaskORM

    await init_db()
    async with session_scope() as db:
        tasks = (await db.execute(select(TaskORM))).scalars().all()
        assert len(tasks) == 2
        names = {t.name for t in tasks}
        assert expected_original_name in names
        assert f"{expected_original_name} (imported)" in names
    await _dispose_engine()


async def _verify_sample_image() -> None:
    from sqlalchemy import select

    from app.config import get_settings
    from app.database import init_db, session_scope
    from app.models.sample import SampleRecordORM, SampleSetORM

    await init_db()
    async with session_scope() as db:
        sets = (await db.execute(select(SampleSetORM))).scalars().all()
        assert len(sets) == 1
        records = (await db.execute(select(SampleRecordORM))).scalars().all()
        assert len(records) == 1
        img_path = records[0].data["images"][0]["path"]
        assert img_path.startswith(str(get_settings().uploads_dir))
        assert Path(img_path).is_file()
    await _dispose_engine()


def test_task_bundle_export_import_round_trip_across_dbs(tmp_path, monkeypatch):
    _reset_singletons(tmp_path / "a", monkeypatch)
    task_id = asyncio.run(_seed_task_round_trip())
    out_path = tmp_path / "a" / "out.mikobundle"
    summary = asyncio.run(_export(task_id, out_path))
    assert summary["entities"] >= 2

    _reset_singletons(tmp_path / "b", monkeypatch)
    report = asyncio.run(_import(out_path))
    assert any(item.startswith("task:") for item in report.created)
    asyncio.run(_verify_b())


def test_import_skip_is_idempotent(tmp_path, monkeypatch):
    _reset_singletons(tmp_path / "a", monkeypatch)
    task_id = asyncio.run(_seed_task_round_trip())
    out_path = tmp_path / "a" / "out.mikobundle"
    summary = asyncio.run(_export(task_id, out_path))
    assert summary["entities"] >= 2

    _reset_singletons(tmp_path / "b", monkeypatch)
    report1 = asyncio.run(_import(out_path))
    assert len(report1.created) >= 2
    report2 = asyncio.run(_import(out_path))
    assert len(report2.skipped) == len(report1.created)
    assert not report2.created


def test_import_duplicate_mode_remaps_ids(tmp_path, monkeypatch):
    from app.services.bundle import ImportOptions

    _reset_singletons(tmp_path / "a", monkeypatch)
    task_id = asyncio.run(_seed_task_round_trip())
    out_path = tmp_path / "a" / "out.mikobundle"
    asyncio.run(_export(task_id, out_path))

    _reset_singletons(tmp_path / "b", monkeypatch)
    asyncio.run(_import(out_path))  # baseline import in skip mode
    report = asyncio.run(_import(out_path, ImportOptions(mode="duplicate")))
    assert any("task:" in item for item in report.duplicated)
    asyncio.run(_verify_duplicate())


def test_secret_never_exported(tmp_path, monkeypatch):
    _reset_singletons(tmp_path, monkeypatch)
    task_id = asyncio.run(_seed_task_round_trip())
    envelope = asyncio.run(_export_envelope(task_id))
    for entity in envelope.entities:
        assert "api_key_encrypted" not in entity.fields
        if entity.kind == "provider_config":
            assert entity.fields.get("base_url") is None
            cached_at = entity.fields.get("models_cached_at")
            assert "models_cached_at" not in entity.fields or cached_at is None


def test_name_collision_renamed(tmp_path, monkeypatch):
    _reset_singletons(tmp_path / "a", monkeypatch)
    task_id = asyncio.run(_seed_task_named("X"))
    out_path = tmp_path / "a" / "out.mikobundle"
    asyncio.run(_export(task_id, out_path))

    _reset_singletons(tmp_path / "b", monkeypatch)
    asyncio.run(_seed_task_named("X"))
    report = asyncio.run(_import(out_path))
    assert any("X (imported)" in name for _, name in report.renamed)
    asyncio.run(_verify_collision("X"))


def test_sample_image_asset_round_trip(tmp_path, monkeypatch):
    _reset_singletons(tmp_path / "a", monkeypatch)
    sample_set_id = asyncio.run(_seed_sample_set_with_image())
    out_path = tmp_path / "a" / "out.zip"
    summary = asyncio.run(_export_sample_set(sample_set_id, out_path))
    assert summary["assets"] == 1

    _reset_singletons(tmp_path / "b", monkeypatch)
    asyncio.run(_import(out_path))
    asyncio.run(_verify_sample_image())


async def _seed_provider_workspace(
    pc_id: str, api_key: str, base_url: str
) -> str:
    """Seed a provider (fixed id) + a task/version that references it."""
    from app.database import init_db, session_scope
    from app.models.provider_config import ProviderConfigORM
    from app.models.task import TaskORM, TaskVersionORM

    await init_db()
    async with session_scope() as db:
        pc = ProviderConfigORM(
            provider_config_id=pc_id,
            name="Provider",
            adapter_id="openai",
            base_url=base_url,
            api_key_encrypted=api_key,
            cached_models=["gpt-4"],
            selected_models=["gpt-4"],
            notes="",
            created_at="2024-01-01T00:00:00+00:00",
            updated_at="2024-01-01T00:00:00+00:00",
        )
        task_id = f"task_{uuid.uuid4().hex[:12]}"
        tv_id = f"tv_{uuid.uuid4().hex[:12]}"
        tv = TaskVersionORM(
            task_version_id=tv_id,
            task_id=task_id,
            version_label="v1",
            system_prompt="sp",
            user_template="u {{x}}",
            provider_config_id=pc_id,
            model_id="gpt-4",
            model_parameters={},
            output_contract={"mode": "free_text"},
            notes="",
            created_at="2024-01-01T00:00:00+00:00",
            updated_at="2024-01-01T00:00:00+00:00",
        )
        task = TaskORM(
            task_id=task_id,
            name="T",
            description="",
            current_version_id=tv_id,
            tags=[],
            created_at="2024-01-01T00:00:00+00:00",
            updated_at="2024-01-01T00:00:00+00:00",
        )
        db.add(pc)
        db.add(tv)
        db.add(task)
        return task_id


async def _verify_provider_secret(
    pc_id: str, expected_key: str, expected_base_url: str
) -> None:
    from sqlalchemy import select

    from app.database import init_db, session_scope
    from app.models.provider_config import ProviderConfigORM

    await init_db()
    async with session_scope() as db:
        pc = (
            await db.execute(
                select(ProviderConfigORM).where(
                    ProviderConfigORM.provider_config_id == pc_id
                )
            )
        ).scalar_one()
        assert pc.api_key_encrypted == expected_key, (
            f"local api_key wiped by overwrite: {pc.api_key_encrypted!r}"
        )
        assert pc.base_url == expected_base_url, (
            f"local base_url wiped by overwrite: {pc.base_url!r}"
        )
    await _dispose_engine()


def test_overwrite_preserves_local_secrets(tmp_path, monkeypatch):
    """Regression: overwrite mode must not clobber a locally-configured
    api_key/base_url with the redacted None the bundle carries."""
    from app.services.bundle import ImportOptions

    pc_id = f"pc_fixed_{uuid.uuid4().hex[:8]}"

    # Workspace A: export a bundle carrying the provider (secret redacted).
    _reset_singletons(tmp_path / "a", monkeypatch)
    task_id = asyncio.run(_seed_provider_workspace(pc_id, "sk-A", "http://A/v1"))
    out_path = tmp_path / "a" / "out.mikobundle"
    asyncio.run(_export(task_id, out_path))

    # Workspace B: same provider id, but a different local secret + endpoint.
    _reset_singletons(tmp_path / "b", monkeypatch)
    asyncio.run(_seed_provider_workspace(pc_id, "sk-LOCAL", "http://LOCAL/v1"))

    report = asyncio.run(_import(out_path, ImportOptions(mode="overwrite")))
    assert any("provider_config:" in u for u in report.updated)

    asyncio.run(_verify_provider_secret(pc_id, "sk-LOCAL", "http://LOCAL/v1"))

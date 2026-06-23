"""Async SQLAlchemy database setup."""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


_engine = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def get_engine():
    global _engine
    if _engine is None:
        settings = get_settings()
        _engine = create_async_engine(
            settings.effective_database_url,
            echo=False,
            future=True,
        )
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(
            get_engine(),
            class_=AsyncSession,
            expire_on_commit=False,
        )
    return _session_factory


async def init_db() -> None:
    """Create all tables. Called once on application startup."""
    # Import models so that they are registered on Base.metadata.
    from app.models import (  # noqa: F401,I001 – side-effect import
        model_config,
        pricing,
        prompt,
        provider_config,
        result_snapshot,
        run,
        sample,
        settings as settings_model,
        task,
    )

    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await _migrate_provider_config_cache_columns(conn)
        await _migrate_pricing_provider_config_column(conn)
        await _migrate_run_items_latency_ms(conn)
        await _migrate_task_image_resolution_columns(conn)
        await _migrate_tasks_to_versions(conn)
        await _recreate_tasks_table_without_legacy_columns(conn)
        await _migrate_result_snapshot_full_snapshot_columns(conn)
        await _migrate_prompt_version_library_columns(conn)
        await _migrate_prompt_version_variable_specs_column(conn)
        await _migrate_pricing_profiles_to_per_million_tokens(conn)


async def _migrate_prompt_version_library_columns(conn) -> None:
    """Add prompt-library columns (image slots / few-shot) for existing DBs."""

    result = await conn.execute(text("PRAGMA table_info(prompt_versions)"))
    existing_columns = {row[1] for row in result.fetchall()}

    if "image_slot_specs" not in existing_columns:
        await conn.execute(
            text("ALTER TABLE prompt_versions ADD COLUMN image_slot_specs JSON DEFAULT '[]'")
        )
    if "few_shot_examples" not in existing_columns:
        await conn.execute(
            text("ALTER TABLE prompt_versions ADD COLUMN few_shot_examples JSON DEFAULT '[]'")
        )


async def _migrate_prompt_version_variable_specs_column(conn) -> None:
    """Add variable-spec columns for existing prompt-version tables."""

    result = await conn.execute(text("PRAGMA table_info(prompt_versions)"))
    existing_columns = {row[1] for row in result.fetchall()}

    if "variable_specs" not in existing_columns:
        await conn.execute(
            text("ALTER TABLE prompt_versions ADD COLUMN variable_specs JSON DEFAULT '[]'")
        )


async def _migrate_result_snapshot_full_snapshot_columns(conn) -> None:
    """Add full reproduction columns to result_snapshots for existing DBs."""

    result = await conn.execute(text("PRAGMA table_info(result_snapshots)"))
    existing_columns = {row[1] for row in result.fetchall()}

    if "internal_request_snapshot" not in existing_columns:
        await conn.execute(
            text("ALTER TABLE result_snapshots ADD COLUMN internal_request_snapshot JSON")
        )
    if "config_snapshot" not in existing_columns:
        await conn.execute(
            text("ALTER TABLE result_snapshots ADD COLUMN config_snapshot JSON")
        )
    if "image_dir" not in existing_columns:
        await conn.execute(
            text("ALTER TABLE result_snapshots ADD COLUMN image_dir VARCHAR")
        )

async def _migrate_provider_config_cache_columns(conn) -> None:
    """Add model-cache columns for existing SQLite databases."""

    result = await conn.execute(text("PRAGMA table_info(provider_configs)"))
    existing_columns = {row[1] for row in result.fetchall()}

    if "cached_models" not in existing_columns:
        await conn.execute(
            text("ALTER TABLE provider_configs ADD COLUMN cached_models JSON DEFAULT '[]'")
        )
    if "selected_models" not in existing_columns:
        await conn.execute(
            text("ALTER TABLE provider_configs ADD COLUMN selected_models JSON DEFAULT '[]'")
        )
    if "models_cached_at" not in existing_columns:
        await conn.execute(
            text("ALTER TABLE provider_configs ADD COLUMN models_cached_at DATETIME")
        )


async def _migrate_pricing_provider_config_column(conn) -> None:
    """Add provider_config_id for existing pricing profile tables."""

    result = await conn.execute(text("PRAGMA table_info(pricing_profiles)"))
    existing_columns = {row[1] for row in result.fetchall()}

    if "provider_config_id" not in existing_columns:
        await conn.execute(
            text("ALTER TABLE pricing_profiles ADD COLUMN provider_config_id VARCHAR")
        )
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS "
                "ix_pricing_profiles_provider_config_id "
                "ON pricing_profiles (provider_config_id)"
            )
        )


async def _migrate_run_items_latency_ms(conn) -> None:
    """Add latency_ms column to run_items for existing databases."""

    result = await conn.execute(text("PRAGMA table_info(run_items)"))
    existing_columns = {row[1] for row in result.fetchall()}

    if "latency_ms" not in existing_columns:
        await conn.execute(
            text("ALTER TABLE run_items ADD COLUMN latency_ms INTEGER")
        )


async def _migrate_pricing_profiles_to_per_million_tokens(conn) -> None:
    """Convert existing pricing profile token prices to per-million units."""

    marker_key = "migration.pricing_profiles.per_million_tokens.v1"
    marker = await conn.execute(
        text("SELECT 1 FROM settings WHERE key = :key LIMIT 1"),
        {"key": marker_key},
    )
    if marker.scalar_one_or_none() is not None:
        return

    result = await conn.execute(text("PRAGMA table_info(pricing_profiles)"))
    existing_columns = {row[1] for row in result.fetchall()}
    required_columns = {
        "input_token_price",
        "output_token_price",
        "cached_input_price",
    }

    if required_columns.issubset(existing_columns):
        await conn.execute(
            text(
                "UPDATE pricing_profiles SET "
                "input_token_price = input_token_price * 1000, "
                "output_token_price = output_token_price * 1000, "
                "cached_input_price = CASE "
                "WHEN cached_input_price IS NULL THEN NULL "
                "ELSE cached_input_price * 1000 END"
            )
        )

    await conn.execute(
        text(
            "INSERT INTO settings (key, value, category, updated_at) "
            "VALUES (:key, 'done', 'migration', CURRENT_TIMESTAMP)"
        ),
        {"key": marker_key},
    )


async def _migrate_task_image_resolution_columns(conn) -> None:
    """Add image resolution settings for existing task tables."""

    result = await conn.execute(text("PRAGMA table_info(tasks)"))
    existing_columns = {row[1] for row in result.fetchall()}

    if "image_resolution_enabled" not in existing_columns:
        await conn.execute(
            text("ALTER TABLE tasks ADD COLUMN image_resolution_enabled BOOLEAN DEFAULT 0")
        )
    if "image_resolution_target" not in existing_columns:
        await conn.execute(
            text("ALTER TABLE tasks ADD COLUMN image_resolution_target INTEGER DEFAULT 1024")
        )


async def _migrate_tasks_to_versions(conn) -> None:
    """Convert legacy flat tasks into task headers plus v1 task versions."""

    result = await conn.execute(text("PRAGMA table_info(tasks)"))
    task_columns = {row[1] for row in result.fetchall()}
    if not task_columns:
        return

    if "description" not in task_columns:
        await conn.execute(text("ALTER TABLE tasks ADD COLUMN description TEXT DEFAULT ''"))
        task_columns.add("description")
    if "current_version_id" not in task_columns:
        await conn.execute(text("ALTER TABLE tasks ADD COLUMN current_version_id VARCHAR"))
        task_columns.add("current_version_id")
    if "tags" not in task_columns:
        await conn.execute(text("ALTER TABLE tasks ADD COLUMN tags JSON DEFAULT '[]'"))
        task_columns.add("tags")

    legacy_columns = {
        "model_id",
        "system_prompt",
        "user_prompt",
        "format_instruction",
    }
    if not legacy_columns.issubset(task_columns):
        return

    rows = (
        await conn.execute(text("SELECT * FROM tasks WHERE current_version_id IS NULL"))
    ).mappings().all()
    for row in rows:
        task_id = row["task_id"]
        existing = await conn.execute(
            text("SELECT task_version_id FROM task_versions WHERE task_id = :task_id LIMIT 1"),
            {"task_id": task_id},
        )
        task_version_id = existing.scalar_one_or_none()
        if task_version_id is None:
            prompt_id = f"prompt_{uuid4().hex[:12]}"
            prompt_version_id = f"pv_{uuid4().hex[:12]}"
            task_version_id = f"tv_{uuid4().hex[:12]}"
            now = row.get("created_at") or row.get("updated_at")

            await conn.execute(
                text(
                    "INSERT INTO prompts "
                    "(prompt_id, name, description, current_version_id, tags, "
                    "created_at, updated_at) "
                    "VALUES (:prompt_id, :name, '', :current_version_id, '[]', "
                    ":created_at, :updated_at)"
                ),
                {
                    "prompt_id": prompt_id,
                    "name": row.get("name") or "",
                    "current_version_id": prompt_version_id,
                    "created_at": now,
                    "updated_at": now,
                },
            )
            await conn.execute(
                text(
                    "INSERT INTO prompt_versions "
                    "(prompt_version_id, prompt_id, version_label, parent_version_id, "
                    "system_prompt, user_template, format_instruction, notes, "
                    "image_slot_specs, variable_specs, few_shot_examples, created_at, updated_at) "
                    "VALUES (:prompt_version_id, :prompt_id, 'v1', NULL, :system_prompt, "
                    ":user_template, :format_instruction, :notes, '[]', '[]', '[]', "
                    ":created_at, :updated_at)"
                ),
                {
                    "prompt_version_id": prompt_version_id,
                    "prompt_id": prompt_id,
                    "system_prompt": row.get("system_prompt") or "",
                    "user_template": row.get("user_prompt") or "",
                    "format_instruction": row.get("format_instruction") or "",
                    "notes": row.get("notes") or "",
                    "created_at": now,
                    "updated_at": now,
                },
            )
            image_config = {}
            if row.get("image_resolution_enabled"):
                image_config = {
                    "enabled": True,
                    "target": row.get("image_resolution_target") or 1024,
                }
            await conn.execute(
                text(
                    "INSERT INTO task_versions "
                    "(task_version_id, task_id, version_label, parent_version_id, prompt_id, "
                    "prompt_version_id, provider_config_id, model_id, model_parameters, "
                    "output_contract, image_preprocess_config, pricing_profile_id, notes, "
                    "created_at, updated_at) "
                    "VALUES (:task_version_id, :task_id, 'v1', NULL, :prompt_id, "
                    ":prompt_version_id, :provider_config_id, :model_id, :model_parameters, "
                    ":output_contract, :image_preprocess_config, :pricing_profile_id, :notes, "
                    ":created_at, :updated_at)"
                ),
                {
                    "task_version_id": task_version_id,
                    "task_id": task_id,
                    "prompt_id": prompt_id,
                    "prompt_version_id": prompt_version_id,
                    "provider_config_id": row.get("provider_config_id"),
                    "model_id": row.get("model_id") or "",
                    "model_parameters": _json_dump(row.get("model_parameters"), {}),
                    "output_contract": _json_dump(row.get("output_contract"), {}),
                    "image_preprocess_config": json.dumps(image_config),
                    "pricing_profile_id": row.get("pricing_profile_id"),
                    "notes": row.get("notes") or "",
                    "created_at": now,
                    "updated_at": now,
                },
            )

        await conn.execute(
            text("UPDATE tasks SET current_version_id = :version_id WHERE task_id = :task_id"),
            {"version_id": task_version_id, "task_id": task_id},
        )


async def _recreate_tasks_table_without_legacy_columns(conn) -> None:
    """Drop legacy NOT NULL columns from the tasks table by recreating it.

    SQLite cannot DROP COLUMN with NOT NULL constraints directly on older
    versions, so we recreate the table with only the current schema columns
    and copy data over.
    """

    result = await conn.execute(text("PRAGMA table_info(tasks)"))
    columns = {row[1] for row in result.fetchall()}
    if not columns:
        return

    legacy_columns = {
        "model_id",
        "system_prompt",
        "user_prompt",
        "format_instruction",
        "provider_config_id",
        "model_parameters",
        "output_contract",
        "pricing_profile_id",
        "image_resolution_enabled",
        "image_resolution_target",
        "notes",
    }
    if not legacy_columns.intersection(columns):
        return

    await conn.execute(
        text(
            "CREATE TABLE tasks_new ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "task_id VARCHAR NOT NULL UNIQUE, "
            "name VARCHAR DEFAULT '', "
            "description TEXT DEFAULT '', "
            "current_version_id VARCHAR, "
            "tags JSON DEFAULT '[]', "
            "created_at VARCHAR, "
            "updated_at VARCHAR"
            ")"
        )
    )
    await conn.execute(
        text(
            "INSERT INTO tasks_new "
            "(task_id, name, description, current_version_id, tags, created_at, updated_at) "
            "SELECT task_id, name, "
            "COALESCE(description, ''), "
            "current_version_id, "
            "COALESCE(tags, '[]'), "
            "created_at, updated_at "
            "FROM tasks"
        )
    )
    await conn.execute(text("DROP TABLE tasks"))
    await conn.execute(text("ALTER TABLE tasks_new RENAME TO tasks"))
    await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tasks_task_id ON tasks (task_id)"))
    await conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_tasks_current_version_id ON tasks (current_version_id)")
    )


def _json_dump(value, default) -> str:
    if value is None:
        return json.dumps(default)
    if isinstance(value, str):
        return value
    return json.dumps(value)


async def _recreate_tasks_table_without_legacy_columns(conn) -> None:
    """Recreate the tasks table without legacy NOT NULL columns.

    After _migrate_tasks_to_versions has moved data into task_versions,
    the old tasks table may still have NOT NULL columns (model_id, etc.)
    that are no longer in the ORM model. SQLite cannot DROP COLUMN on
    older versions, so we recreate the table cleanly.
    """
    result = await conn.execute(text("PRAGMA table_info(tasks)"))
    columns = {row[1] for row in result.fetchall()}
    if not columns:
        return

    # Only recreate if legacy columns still exist
    legacy_columns = {"model_id", "system_prompt", "user_prompt", "format_instruction"}
    if not legacy_columns.intersection(columns):
        return

    await conn.execute(
        text(
            "CREATE TABLE tasks_new ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "task_id VARCHAR NOT NULL UNIQUE, "
            "name VARCHAR DEFAULT '', "
            "description TEXT DEFAULT '', "
            "current_version_id VARCHAR, "
            "tags JSON DEFAULT '[]', "
            "created_at VARCHAR, "
            "updated_at VARCHAR"
            ")"
        )
    )

    # Copy non-legacy data
    copy_cols = []
    for col in ("task_id", "name", "description", "current_version_id", "tags", "created_at", "updated_at"):
        if col in columns:
            copy_cols.append(col)
    col_list = ", ".join(copy_cols)
    await conn.execute(
        text(f"INSERT INTO tasks_new ({col_list}) SELECT {col_list} FROM tasks")
    )

    await conn.execute(text("DROP TABLE tasks"))
    await conn.execute(text("ALTER TABLE tasks_new RENAME TO tasks"))

    # Recreate indexes
    await conn.execute(text("CREATE UNIQUE INDEX ix_tasks_task_id ON tasks (task_id)"))
    await conn.execute(text("CREATE INDEX ix_tasks_current_version_id ON tasks (current_version_id)"))


async def _recreate_tasks_table_without_legacy_columns(conn) -> None:
    """Recreate the tasks table without legacy NOT NULL columns (model_id, etc.).

    SQLite cannot DROP COLUMN with NOT NULL constraints on older versions,
    so we recreate the table with only the current ORM schema columns.
    """

    result = await conn.execute(text("PRAGMA table_info(tasks)"))
    columns = {row[1] for row in result.fetchall()}
    if not columns:
        return

    legacy_columns = {
        "model_id",
        "system_prompt",
        "user_prompt",
        "format_instruction",
        "provider_config_id",
        "model_parameters",
        "output_contract",
        "pricing_profile_id",
        "image_resolution_enabled",
        "image_resolution_target",
        "notes",
    }
    if not legacy_columns.intersection(columns):
        return

    await conn.execute(
        text(
            "CREATE TABLE tasks_new ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "task_id VARCHAR NOT NULL UNIQUE, "
            "name VARCHAR DEFAULT '', "
            "description TEXT DEFAULT '', "
            "current_version_id VARCHAR, "
            "tags JSON DEFAULT '[]', "
            "created_at VARCHAR, "
            "updated_at VARCHAR"
            ")"
        )
    )
    await conn.execute(
        text(
            "INSERT INTO tasks_new "
            "(task_id, name, description, current_version_id, tags, created_at, updated_at) "
            "SELECT task_id, "
            "COALESCE(name, ''), "
            "COALESCE(description, ''), "
            "current_version_id, "
            "COALESCE(tags, '[]'), "
            "COALESCE(created_at, ''), "
            "COALESCE(updated_at, '') "
            "FROM tasks"
        )
    )
    await conn.execute(text("DROP TABLE tasks"))
    await conn.execute(text("ALTER TABLE tasks_new RENAME TO tasks"))
    await conn.execute(text("CREATE INDEX ix_tasks_task_id ON tasks (task_id)"))
    await conn.execute(
        text("CREATE INDEX ix_tasks_current_version_id ON tasks (current_version_id)")
    )


async def _recreate_tasks_table_without_legacy_columns(conn) -> None:
    """Recreate the tasks table without legacy NOT NULL columns (model_id, etc.).

    After ``_migrate_tasks_to_versions`` has moved data into ``task_versions``,
    the old ``tasks`` table may still carry NOT NULL columns like ``model_id``
    that no longer exist in the ORM model.  SQLite cannot drop columns in-place
    (pre-3.35), so we recreate the table with only the current schema columns.
    """

    result = await conn.execute(text("PRAGMA table_info(tasks)"))
    columns = {row[1] for row in result.fetchall()}
    if not columns:
        return

    legacy_columns = {
        "model_id",
        "system_prompt",
        "user_prompt",
        "format_instruction",
        "provider_config_id",
        "model_parameters",
        "output_contract",
        "pricing_profile_id",
        "image_resolution_enabled",
        "image_resolution_target",
        "notes",
    }
    if not legacy_columns.intersection(columns):
        return

    await conn.execute(
        text(
            "CREATE TABLE _tasks_new ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "task_id VARCHAR NOT NULL UNIQUE, "
            "name VARCHAR DEFAULT '', "
            "description TEXT DEFAULT '', "
            "current_version_id VARCHAR, "
            "tags JSON DEFAULT '[]', "
            "created_at VARCHAR, "
            "updated_at VARCHAR"
            ")"
        )
    )
    await conn.execute(
        text(
            "INSERT INTO _tasks_new "
            "(task_id, name, description, current_version_id, tags, created_at, updated_at) "
            "SELECT task_id, name, "
            "COALESCE(description, ''), "
            "current_version_id, "
            "COALESCE(tags, '[]'), "
            "COALESCE(created_at, ''), "
            "COALESCE(updated_at, '') "
            "FROM tasks"
        )
    )
    await conn.execute(text("DROP TABLE tasks"))
    await conn.execute(text("ALTER TABLE _tasks_new RENAME TO tasks"))
    await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tasks_task_id ON tasks (task_id)"))
    await conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_tasks_current_version_id ON tasks (current_version_id)")
    )


async def _recreate_tasks_table_without_legacy_columns(conn) -> None:
    """Recreate the tasks table without legacy NOT NULL columns.

    After migrating data to task_versions, the old ``tasks`` table may still
    have NOT NULL columns like ``model_id`` that are no longer in the ORM model.
    SQLite cannot DROP COLUMN on older versions, so we recreate the table.
    """
    result = await conn.execute(text("PRAGMA table_info(tasks)"))
    columns = {row[1] for row in result.fetchall()}
    if not columns:
        return

    legacy_columns = {
        "model_id",
        "system_prompt",
        "user_prompt",
        "format_instruction",
        "provider_config_id",
        "model_parameters",
        "output_contract",
        "pricing_profile_id",
        "image_resolution_enabled",
        "image_resolution_target",
        "notes",
    }
    if not legacy_columns.intersection(columns):
        return

    await conn.execute(
        text(
            "CREATE TABLE tasks_new ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "task_id VARCHAR NOT NULL UNIQUE, "
            "name VARCHAR DEFAULT '', "
            "description TEXT DEFAULT '', "
            "current_version_id VARCHAR, "
            "tags JSON DEFAULT '[]', "
            "created_at VARCHAR, "
            "updated_at VARCHAR"
            ")"
        )
    )
    await conn.execute(
        text(
            "INSERT INTO tasks_new "
            "(task_id, name, description, current_version_id, tags, created_at, updated_at) "
            "SELECT task_id, name, "
            "COALESCE(description, ''), "
            "current_version_id, "
            "COALESCE(tags, '[]'), "
            "created_at, updated_at "
            "FROM tasks"
        )
    )
    await conn.execute(text("DROP TABLE tasks"))
    await conn.execute(text("ALTER TABLE tasks_new RENAME TO tasks"))
    await conn.execute(text("CREATE INDEX ix_tasks_task_id ON tasks (task_id)"))
    await conn.execute(
        text("CREATE INDEX ix_tasks_current_version_id ON tasks (current_version_id)")
    )


@asynccontextmanager
async def session_scope() -> AsyncGenerator[AsyncSession, None]:
    """Context manager that yields a session and commits/rolls back automatically."""
    factory = get_session_factory()
    async with factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency – yields a session without committing."""
    factory = get_session_factory()
    async with factory() as session:
        yield session

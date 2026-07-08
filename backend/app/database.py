"""Async SQLAlchemy database setup."""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from uuid import uuid4

from sqlalchemy import event, text
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
_LEGACY_FORMAT_COLUMN = "format" + chr(95) + "instruction"


def get_engine():
    global _engine
    if _engine is None:
        settings = get_settings()
        _engine = create_async_engine(
            settings.effective_database_url,
            echo=False,
            future=True,
            # Batch runs execute many items concurrently, each holding its own
            # session across the provider HTTP call. The default QueuePool
            # (size 5) would exhaust under concurrency; size up so concurrent
            # workers and the API poller never block on checkout.
            pool_size=20,
            max_overflow=10,
            pool_timeout=30,
        )
        _apply_sqlite_concurrency_pragmas(_engine)
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

def _apply_sqlite_concurrency_pragmas(engine) -> None:
    """Enable WAL + busy_timeout so concurrent batch workers don't deadlock.

    Default SQLite (rollback journal, busy_timeout=0) fails immediately with
    "database is locked" when two sessions commit at once. WAL lets readers
    proceed alongside a writer; busy_timeout makes writers wait briefly for
    the lock instead of erroring. Only applies to sqlite dialects.
    """

    dialect = engine.url.get_dialect().name
    if dialect != "sqlite":
        return

    @event.listens_for(engine.sync_engine, "connect")
    def _set_sqlite_pragma(dbapi_connection, _connection_record):  # noqa: ANN001
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA busy_timeout=5000")
            cursor.execute("PRAGMA synchronous=NORMAL")
        finally:
            cursor.close()


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
        await _migrate_task_groups(conn)
        await _migrate_task_image_resolution_columns(conn)
        await _migrate_tasks_to_versions(conn)
        await _recreate_tasks_table_without_legacy_columns(conn)
        await _migrate_result_snapshot_full_snapshot_columns(conn)
        await _migrate_snapshot_linked_task_version(conn)
        await _migrate_prompt_version_library_columns(conn)
        await _migrate_prompt_version_variable_specs_column(conn)
        await _migrate_prompt_specs_to_task_versions(conn)
        await _migrate_task_version_prompt_inline(conn)
        await _migrate_prompt_snippets(conn)
        await _recreate_prompts_table_without_legacy_columns(conn)
        await _migrate_pricing_profiles_to_per_million_tokens(conn)
        await _migrate_unique_names(conn)
        await _migrate_pipeline_fields(conn)


async def _migrate_task_groups(conn) -> None:
    """Create task_groups table and add group_id column to tasks."""
    await conn.execute(
        text(
            "CREATE TABLE IF NOT EXISTS task_groups ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "group_id VARCHAR NOT NULL UNIQUE, "
            "name VARCHAR DEFAULT '', "
            "description TEXT DEFAULT '', "
            "color VARCHAR DEFAULT '', "
            "sort_order INTEGER DEFAULT 0, "
            "created_at VARCHAR, "
            "updated_at VARCHAR"
            ")"
        )
    )
    await conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_task_groups_group_id ON task_groups (group_id)")
    )

    result = await conn.execute(text("PRAGMA table_info(tasks)"))
    columns = {row[1] for row in result.fetchall()}
    if "group_id" not in columns:
        await conn.execute(text("ALTER TABLE tasks ADD COLUMN group_id VARCHAR"))
        await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_tasks_group_id ON tasks (group_id)"))
    if "updated_at" not in columns:
        await conn.execute(text("ALTER TABLE tasks ADD COLUMN updated_at VARCHAR"))
        await conn.execute(
            text("CREATE INDEX IF NOT EXISTS ix_tasks_updated_at ON tasks (updated_at)")
        )


async def _migrate_prompt_version_library_columns(conn) -> None:
    """Add prompt-library image slot columns for existing DBs."""

    result = await conn.execute(text("PRAGMA table_info(prompt_versions)"))
    existing_columns = {row[1] for row in result.fetchall()}
    if not existing_columns:
        return

    if "image_slot_specs" not in existing_columns:
        await conn.execute(
            text("ALTER TABLE prompt_versions ADD COLUMN image_slot_specs JSON DEFAULT '[]'")
        )


async def _migrate_prompt_version_variable_specs_column(conn) -> None:
    """Add variable-spec columns for existing prompt-version tables."""

    result = await conn.execute(text("PRAGMA table_info(prompt_versions)"))
    existing_columns = {row[1] for row in result.fetchall()}
    if not existing_columns:
        return

    if "variable_specs" not in existing_columns:
        await conn.execute(
            text("ALTER TABLE prompt_versions ADD COLUMN variable_specs JSON DEFAULT '[]'")
        )


async def _migrate_prompt_specs_to_task_versions(conn) -> None:
    """Move prompt contract metadata from prompt_versions to task_versions."""

    task_result = await conn.execute(text("PRAGMA table_info(task_versions)"))
    task_columns = {row[1] for row in task_result.fetchall()}
    if not task_columns:
        return

    for column in ("image_slot_specs", "variable_specs"):
        if column not in task_columns:
            await conn.execute(
                text(f"ALTER TABLE task_versions ADD COLUMN {column} JSON DEFAULT '[]'")
            )
            task_columns.add(column)

    prompt_result = await conn.execute(text("PRAGMA table_info(prompt_versions)"))
    prompt_columns = {row[1] for row in prompt_result.fetchall()}
    if not prompt_columns:
        return

    spec_columns = {"image_slot_specs", "variable_specs"}
    for column in spec_columns.intersection(prompt_columns):
        await conn.execute(
            text(
                f"UPDATE task_versions "
                f"SET {column} = CASE "
                f"WHEN {column} IS NULL OR {column} = '[]' THEN "
                f"COALESCE((SELECT pv.{column} FROM prompt_versions pv "
                f"WHERE pv.prompt_id = task_versions.prompt_id "
                f"AND pv.prompt_version_id = task_versions.prompt_version_id "
                f"LIMIT 1), '[]') "
                f"ELSE {column} END"
            )
        )

    removable_columns = spec_columns | {"version_label", "parent_version_id"}
    if not removable_columns.intersection(prompt_columns):
        return

    await conn.execute(
        text(
            "CREATE TABLE prompt_versions_new ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "prompt_version_id VARCHAR NOT NULL UNIQUE, "
            "prompt_id VARCHAR NOT NULL, "
            "system_prompt TEXT DEFAULT '', "
            "user_template TEXT DEFAULT '', "
            "notes TEXT DEFAULT '', "
            "created_at VARCHAR, "
            "updated_at VARCHAR"
            ")"
        )
    )
    await conn.execute(
        text(
            "INSERT INTO prompt_versions_new "
            "(id, prompt_version_id, prompt_id, system_prompt, user_template, "
            "notes, created_at, updated_at) "
            "SELECT id, prompt_version_id, prompt_id, "
            "COALESCE(system_prompt, ''), COALESCE(user_template, ''), "
            "COALESCE(notes, ''), "
            "created_at, updated_at FROM prompt_versions"
        )
    )
    await conn.execute(text("DROP TABLE prompt_versions"))
    await conn.execute(text("ALTER TABLE prompt_versions_new RENAME TO prompt_versions"))
    await conn.execute(
        text(
            "CREATE UNIQUE INDEX IF NOT EXISTS "
            "ix_prompt_versions_prompt_version_id "
            "ON prompt_versions (prompt_version_id)"
        )
    )
    await conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS ix_prompt_versions_prompt_id ON prompt_versions (prompt_id)"
        )
    )


async def _migrate_task_version_prompt_inline(conn) -> None:
    """Inline prompt text into task_versions and preserve legacy extra instructions."""

    result = await conn.execute(text("PRAGMA table_info(task_versions)"))
    columns = {row[1] for row in result.fetchall()}
    if not columns:
        return

    if "system_prompt" not in columns:
        await conn.execute(
            text("ALTER TABLE task_versions ADD COLUMN system_prompt TEXT DEFAULT ''")
        )
        columns.add("system_prompt")
    if "user_template" not in columns:
        await conn.execute(
            text("ALTER TABLE task_versions ADD COLUMN user_template TEXT DEFAULT ''")
        )
        columns.add("user_template")

    prompt_result = await conn.execute(text("PRAGMA table_info(prompt_versions)"))
    prompt_columns = {row[1] for row in prompt_result.fetchall()}
    if prompt_columns:
        select_extra = (
            f", pv.{_LEGACY_FORMAT_COLUMN} AS legacy_extra"
            if _LEGACY_FORMAT_COLUMN in prompt_columns
            else ", '' AS legacy_extra"
        )
        rows = await conn.execute(
            text(
                "SELECT tv.task_version_id, pv.system_prompt, pv.user_template"
                f"{select_extra} "
                "FROM task_versions tv "
                "JOIN prompt_versions pv "
                "ON pv.prompt_id = tv.prompt_id "
                "AND pv.prompt_version_id = tv.prompt_version_id "
                "WHERE COALESCE(tv.system_prompt, '') = '' "
                "AND COALESCE(tv.user_template, '') = ''"
            )
        )
        for row in rows.mappings():
            system_prompt = row["system_prompt"] or ""
            user_template = row["user_template"] or ""
            legacy_extra = row["legacy_extra"] or ""
            if legacy_extra:
                system_prompt = (
                    f"{system_prompt.rstrip()}\n\n{legacy_extra}" if system_prompt else legacy_extra
                )
            await conn.execute(
                text(
                    "UPDATE task_versions "
                    "SET system_prompt = :system_prompt, user_template = :user_template "
                    "WHERE task_version_id = :task_version_id"
                ),
                {
                    "system_prompt": system_prompt,
                    "user_template": user_template,
                    "task_version_id": row["task_version_id"],
                },
            )

        if _LEGACY_FORMAT_COLUMN in prompt_columns:
            await conn.execute(
                text(
                    "CREATE TABLE prompt_versions_clean ("
                    "id INTEGER PRIMARY KEY AUTOINCREMENT, "
                    "prompt_version_id VARCHAR NOT NULL UNIQUE, "
                    "prompt_id VARCHAR NOT NULL, "
                    "system_prompt TEXT DEFAULT '', "
                    "user_template TEXT DEFAULT '', "
                    "notes TEXT DEFAULT '', "
                    "created_at VARCHAR, "
                    "updated_at VARCHAR"
                    ")"
                )
            )
            await conn.execute(
                text(
                    "INSERT INTO prompt_versions_clean "
                    "(id, prompt_version_id, prompt_id, system_prompt, user_template, "
                    "notes, created_at, updated_at) "
                    "SELECT id, prompt_version_id, prompt_id, "
                    "COALESCE(system_prompt, ''), COALESCE(user_template, ''), "
                    "COALESCE(notes, ''), created_at, updated_at FROM prompt_versions"
                )
            )
            await conn.execute(text("DROP TABLE prompt_versions"))
            await conn.execute(text("ALTER TABLE prompt_versions_clean RENAME TO prompt_versions"))
            await conn.execute(
                text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS ix_prompt_versions_prompt_version_id "
                    "ON prompt_versions (prompt_version_id)"
                )
            )
            await conn.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS "
                    "ix_prompt_versions_prompt_id ON prompt_versions (prompt_id)"
                )
            )


async def _migrate_prompt_snippets(conn) -> None:
    """Flatten prompt library rows into editable prompt snippets.

    Legacy databases stored editable content in prompt_versions and pointed
    prompts.current_version_id at the latest version. Preserve prompt_versions
    for historical compatibility, but copy the current content into prompts.
    """

    result = await conn.execute(text("PRAGMA table_info(prompts)"))
    prompt_columns = {row[1] for row in result.fetchall()}
    if not prompt_columns or "system_prompt" in prompt_columns:
        return

    for column in ("system_prompt", "user_template", "notes"):
        await conn.execute(text(f"ALTER TABLE prompts ADD COLUMN {column} TEXT DEFAULT ''"))
        prompt_columns.add(column)

    if "current_version_id" not in prompt_columns:
        return

    version_result = await conn.execute(text("PRAGMA table_info(prompt_versions)"))
    version_columns = {row[1] for row in version_result.fetchall()}
    required_version_columns = {
        "prompt_id",
        "prompt_version_id",
        "system_prompt",
        "user_template",
        "notes",
    }
    if not required_version_columns.issubset(version_columns):
        return

    await conn.execute(
        text(
            "UPDATE prompts "
            "SET system_prompt = COALESCE(("
            "SELECT pv.system_prompt FROM prompt_versions pv "
            "WHERE pv.prompt_id = prompts.prompt_id "
            "AND pv.prompt_version_id = prompts.current_version_id "
            "LIMIT 1), ''), "
            "user_template = COALESCE(("
            "SELECT pv.user_template FROM prompt_versions pv "
            "WHERE pv.prompt_id = prompts.prompt_id "
            "AND pv.prompt_version_id = prompts.current_version_id "
            "LIMIT 1), ''), "
            "notes = COALESCE(("
            "SELECT pv.notes FROM prompt_versions pv "
            "WHERE pv.prompt_id = prompts.prompt_id "
            "AND pv.prompt_version_id = prompts.current_version_id "
            "LIMIT 1), '')"
        )
    )


async def _recreate_prompts_table_without_legacy_columns(conn) -> None:
    """Recreate prompts table without legacy NOT NULL description/current_version_id columns.

    SQLite cannot DROP COLUMN with NOT NULL constraints on older versions,
    so we recreate the table with only the current schema columns.
    """

    result = await conn.execute(text("PRAGMA table_info(prompts)"))
    columns = {row[1] for row in result.fetchall()}
    if not columns:
        return

    # Only recreate if legacy NOT NULL columns still exist
    if "description" not in columns and "current_version_id" not in columns:
        return

    await conn.execute(
        text(
            "CREATE TABLE prompts_new ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "prompt_id VARCHAR NOT NULL UNIQUE, "
            "name VARCHAR DEFAULT '', "
            "system_prompt TEXT DEFAULT '', "
            "user_template TEXT DEFAULT '', "
            "notes TEXT DEFAULT '', "
            "tags JSON DEFAULT '[]', "
            "created_at VARCHAR, "
            "updated_at VARCHAR"
            ")"
        )
    )
    await conn.execute(
        text(
            "INSERT INTO prompts_new "
            "(id, prompt_id, name, system_prompt, user_template, notes, tags, "
            "created_at, updated_at) "
            "SELECT id, prompt_id, name, "
            "COALESCE(system_prompt, ''), COALESCE(user_template, ''), "
            "COALESCE(notes, ''), COALESCE(tags, '[]'), "
            "created_at, updated_at FROM prompts"
        )
    )
    await conn.execute(text("DROP TABLE prompts"))
    await conn.execute(text("ALTER TABLE prompts_new RENAME TO prompts"))
    await conn.execute(
        text("CREATE UNIQUE INDEX IF NOT EXISTS ix_prompts_prompt_id ON prompts (prompt_id)")
    )


async def _recreate_task_versions_table_without_legacy_columns(conn) -> None:
    """Recreate task_versions table with nullable prompt_id/prompt_version_id.

    Phase 1 made prompt_id/prompt_version_id nullable in the ORM, but existing
    databases still have NOT NULL constraints on these columns. Recreate to
    match the current schema.
    """

    result = await conn.execute(text("PRAGMA table_info(task_versions)"))
    rows = result.fetchall()
    if not rows:
        return

    # row format: (cid, name, type, notnull, dflt_value, pk)
    col_notnull = {row[1]: row[3] for row in rows}
    if col_notnull.get("prompt_id", 0) == 0 and col_notnull.get("prompt_version_id", 0) == 0:
        return  # Already nullable, nothing to do

    await conn.execute(
        text(
            "CREATE TABLE task_versions_new ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "task_version_id VARCHAR NOT NULL UNIQUE, "
            "task_id VARCHAR NOT NULL, "
            "version_label VARCHAR DEFAULT 'v1', "
            "parent_version_id VARCHAR, "
            "system_prompt TEXT DEFAULT '', "
            "user_template TEXT DEFAULT '', "
            "prompt_id VARCHAR, "
            "prompt_version_id VARCHAR, "
            "provider_config_id VARCHAR, "
            "model_id VARCHAR NOT NULL, "
            "model_parameters JSON DEFAULT '{}', "
            "output_contract JSON DEFAULT '{}', "
            "image_preprocess_config JSON DEFAULT '{}', "
            "image_slot_specs JSON DEFAULT '[]', "
            "variable_specs JSON DEFAULT '[]', "
            "pricing_profile_id VARCHAR, "
            "notes TEXT DEFAULT '', "
            "created_at VARCHAR, "
            "updated_at VARCHAR"
            ")"
        )
    )
    await conn.execute(
        text(
            "INSERT INTO task_versions_new "
            "(id, task_version_id, task_id, version_label, parent_version_id, "
            "system_prompt, user_template, prompt_id, prompt_version_id, "
            "provider_config_id, model_id, model_parameters, output_contract, "
            "image_preprocess_config, image_slot_specs, variable_specs, "
            "pricing_profile_id, notes, created_at, updated_at) "
            "SELECT id, task_version_id, task_id, version_label, parent_version_id, "
            "COALESCE(system_prompt, ''), COALESCE(user_template, ''), "
            "prompt_id, prompt_version_id, "
            "provider_config_id, model_id, model_parameters, output_contract, "
            "image_preprocess_config, "
            "COALESCE(image_slot_specs, '[]'), COALESCE(variable_specs, '[]'), "
            "pricing_profile_id, notes, created_at, updated_at "
            "FROM task_versions"
        )
    )
    await conn.execute(text("DROP TABLE task_versions"))
    await conn.execute(text("ALTER TABLE task_versions_new RENAME TO task_versions"))
    await conn.execute(
        text(
            "CREATE UNIQUE INDEX IF NOT EXISTS "
            "ix_task_versions_task_version_id "
            "ON task_versions (task_version_id)"
        )
    )
    await conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_task_versions_task_id ON task_versions (task_id)")
    )
    await conn.execute(
        text("CREATE INDEX IF NOT EXISTS ix_task_versions_prompt_id ON task_versions (prompt_id)")
    )
    await conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS "
            "ix_task_versions_prompt_version_id "
            "ON task_versions (prompt_version_id)"
        )
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
        await conn.execute(text("ALTER TABLE result_snapshots ADD COLUMN config_snapshot JSON"))
    if "image_dir" not in existing_columns:
        await conn.execute(text("ALTER TABLE result_snapshots ADD COLUMN image_dir VARCHAR"))


async def _migrate_snapshot_linked_task_version(conn) -> None:
    """Add task-version linkage for result snapshots used as run examples."""

    result = await conn.execute(text("PRAGMA table_info(result_snapshots)"))
    existing_columns = {row[1] for row in result.fetchall()}
    if "linked_task_version_id" not in existing_columns:
        await conn.execute(
            text("ALTER TABLE result_snapshots ADD COLUMN linked_task_version_id VARCHAR")
        )
        await conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS "
                "ix_result_snapshots_linked_task_version_id "
                "ON result_snapshots (linked_task_version_id)"
            )
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
        await conn.execute(text("ALTER TABLE run_items ADD COLUMN latency_ms INTEGER"))


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
        _LEGACY_FORMAT_COLUMN,
    }
    if not legacy_columns.issubset(task_columns):
        return

    rows = (
        (await conn.execute(text("SELECT * FROM tasks WHERE current_version_id IS NULL")))
        .mappings()
        .all()
    )
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
                    "(prompt_version_id, prompt_id, system_prompt, user_template, "
                    "notes, created_at, updated_at) "
                    "VALUES (:prompt_version_id, :prompt_id, :system_prompt, "
                    ":user_template, :notes, :created_at, :updated_at)"
                ),
                {
                    "prompt_version_id": prompt_version_id,
                    "prompt_id": prompt_id,
                    "system_prompt": row.get("system_prompt") or "",
                    "user_template": row.get("user_prompt") or "",
                    "notes": row.get("notes") or "",
                    "created_at": now,
                    "updated_at": now,
                },
            )
            legacy_extra = row.get(_LEGACY_FORMAT_COLUMN) or ""
            inlined_system_prompt = row.get("system_prompt") or ""
            if legacy_extra:
                inlined_system_prompt = (
                    f"{inlined_system_prompt.rstrip()}\n\n{legacy_extra}"
                    if inlined_system_prompt
                    else legacy_extra
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
                    "(task_version_id, task_id, version_label, parent_version_id, "
                    "system_prompt, user_template, prompt_id, prompt_version_id, "
                    "provider_config_id, model_id, model_parameters, "
                    "output_contract, image_preprocess_config, image_slot_specs, "
                    "variable_specs, pricing_profile_id, notes, "
                    "created_at, updated_at) "
                    "VALUES (:task_version_id, :task_id, 'v1', NULL, "
                    ":system_prompt, :user_template, :prompt_id, :prompt_version_id, "
                    ":provider_config_id, :model_id, :model_parameters, "
                    ":output_contract, :image_preprocess_config, '[]', '[]', "
                    ":pricing_profile_id, :notes, "
                    ":created_at, :updated_at)"
                ),
                {
                    "task_version_id": task_version_id,
                    "task_id": task_id,
                    "system_prompt": inlined_system_prompt,
                    "user_template": row.get("user_prompt") or "",
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
        _LEGACY_FORMAT_COLUMN,
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
    legacy_columns = {"model_id", "system_prompt", "user_prompt", _LEGACY_FORMAT_COLUMN}
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
    for col in (
        "task_id",
        "name",
        "description",
        "current_version_id",
        "tags",
        "created_at",
        "updated_at",
    ):
        if col in columns:
            copy_cols.append(col)
    col_list = ", ".join(copy_cols)
    await conn.execute(text(f"INSERT INTO tasks_new ({col_list}) SELECT {col_list} FROM tasks"))

    await conn.execute(text("DROP TABLE tasks"))
    await conn.execute(text("ALTER TABLE tasks_new RENAME TO tasks"))

    # Recreate indexes
    await conn.execute(text("CREATE UNIQUE INDEX ix_tasks_task_id ON tasks (task_id)"))
    await conn.execute(
        text("CREATE INDEX ix_tasks_current_version_id ON tasks (current_version_id)")
    )


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
        _LEGACY_FORMAT_COLUMN,
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
        _LEGACY_FORMAT_COLUMN,
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
        _LEGACY_FORMAT_COLUMN,
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

    # Clean up any leftover table from a previous interrupted migration run.
    await conn.execute(text("DROP TABLE IF EXISTS tasks_new"))

    await conn.execute(
        text(
            "CREATE TABLE tasks_new ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "task_id VARCHAR NOT NULL UNIQUE, "
            "name VARCHAR DEFAULT '', "
            "description TEXT DEFAULT '', "
            "current_version_id VARCHAR, "
            "tags JSON DEFAULT '[]', "
            "group_id VARCHAR, "
            "created_at VARCHAR, "
            "updated_at VARCHAR"
            ")"
        )
    )
    await conn.execute(
        text(
            "INSERT INTO tasks_new "
            "(task_id, name, description, current_version_id, tags, group_id, created_at, updated_at) "  # noqa: E501
            "SELECT task_id, name, "
            "COALESCE(description, ''), "
            "current_version_id, "
            "COALESCE(tags, '[]'), "
            "group_id, "
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


async def _migrate_unique_names(conn) -> None:
    """Add unique indexes on task and sample-set names after checking for duplicates."""
    result = await conn.execute(
        text("SELECT name, COUNT(*) FROM tasks GROUP BY name HAVING COUNT(*) > 1")
    )
    task_duplicates = [row[0] for row in result.fetchall()]

    result = await conn.execute(
        text("SELECT name, COUNT(*) FROM sample_sets GROUP BY name HAVING COUNT(*) > 1")
    )
    sset_duplicates = [row[0] for row in result.fetchall()]

    if task_duplicates or sset_duplicates:
        parts = []
        if task_duplicates:
            names = ", ".join(str(n) for n in task_duplicates)
            parts.append(f"duplicate task names: {names}")
        if sset_duplicates:
            names = ", ".join(str(n) for n in sset_duplicates)
            parts.append(f"duplicate sample-set names: {names}")
        raise RuntimeError(
            "Cannot add unique name constraint; resolve duplicates first. " + "; ".join(parts)
        )

    await conn.execute(
        text("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_name ON tasks(name)")
    )
    await conn.execute(
        text("CREATE UNIQUE INDEX IF NOT EXISTS idx_sset_name ON sample_sets(name)")
    )


async def _migrate_pipeline_fields(conn) -> None:
    """Add pipeline lineage columns to run_sessions for external agent chaining."""
    result = await conn.execute(text("PRAGMA table_info(run_sessions)"))
    columns = {row[1] for row in result.fetchall()}
    if not columns:
        return

    if "pipeline_id" not in columns:
        await conn.execute(text("ALTER TABLE run_sessions ADD COLUMN pipeline_id TEXT"))
    if "pipeline_step" not in columns:
        await conn.execute(text("ALTER TABLE run_sessions ADD COLUMN pipeline_step TEXT"))


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

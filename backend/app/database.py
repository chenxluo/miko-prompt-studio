"""Async SQLAlchemy database setup."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

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
        await _migrate_result_snapshot_full_snapshot_columns(conn)
        await _migrate_prompt_version_library_columns(conn)
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

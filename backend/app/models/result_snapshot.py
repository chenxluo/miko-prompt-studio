"""ORM model for curated result snapshots."""

from __future__ import annotations

from typing import Any

from sqlalchemy import JSON, Boolean, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.schemas.common import utc_now


class ResultSnapshotORM(Base):
    __tablename__ = "result_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    snapshot_id: Mapped[str] = mapped_column(String, unique=True, index=True)
    run_id: Mapped[str] = mapped_column(String, index=True)
    run_item_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    attempt_id: Mapped[str | None] = mapped_column(String, nullable=True)

    name: Mapped[str] = mapped_column(String, default="")
    description: Mapped[str] = mapped_column(Text, default="")
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    starred: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    accepted: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    rating: Mapped[int | None] = mapped_column(Integer, nullable=True)

    provider_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    model_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    prompt_version_id: Mapped[str | None] = mapped_column(String, nullable=True)
    linked_task_version_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    thumbnail_image_uri: Mapped[str | None] = mapped_column(String, nullable=True)

    # Full reproduction payload: internal request + session config snapshot.
    # Images referenced here are copied into the snapshot's own directory so
    # the snapshot survives after original upload/cache files are removed.
    internal_request_snapshot: Mapped[dict[str, Any] | None] = mapped_column(
        JSON, nullable=True
    )
    config_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    image_dir: Mapped[str | None] = mapped_column(String, nullable=True)

    created_at: Mapped[str] = mapped_column(
        String,
        default=lambda: utc_now().isoformat(),
        index=True,
    )
    updated_at: Mapped[str] = mapped_column(String, default=lambda: utc_now().isoformat())

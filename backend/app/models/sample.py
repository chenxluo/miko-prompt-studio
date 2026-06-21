"""ORM models for samples and sample sets."""

from __future__ import annotations

from typing import Any

from sqlalchemy import JSON, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.schemas.common import utc_now


class SampleSetORM(Base):
    __tablename__ = "sample_sets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    sample_set_id: Mapped[str] = mapped_column(String, unique=True, index=True)
    name: Mapped[str] = mapped_column(String, default="")
    description: Mapped[str] = mapped_column(Text, default="")
    import_source: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    record_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    metadata_: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict)
    created_at: Mapped[str] = mapped_column(String, default=lambda: utc_now().isoformat())
    updated_at: Mapped[str] = mapped_column(String, default=lambda: utc_now().isoformat())


class SampleRecordORM(Base):
    __tablename__ = "sample_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    sample_id: Mapped[str] = mapped_column(String, index=True)
    sample_set_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    sample_type: Mapped[str] = mapped_column(String, default="single_image")
    data: Mapped[dict[str, Any]] = mapped_column(JSON)  # full SampleRecord JSON
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[str] = mapped_column(String, default=lambda: utc_now().isoformat())
    updated_at: Mapped[str] = mapped_column(String, default=lambda: utc_now().isoformat())

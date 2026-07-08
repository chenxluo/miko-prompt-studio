"""ORM models for saved Tasks and Task Versions."""

from __future__ import annotations

from typing import Any

from sqlalchemy import JSON, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.schemas.common import utc_now


class TaskGroupORM(Base):
    __tablename__ = "task_groups"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    group_id: Mapped[str] = mapped_column(String, unique=True, index=True)
    name: Mapped[str] = mapped_column(String, default="")
    description: Mapped[str] = mapped_column(Text, default="")
    color: Mapped[str] = mapped_column(String, default="")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[str] = mapped_column(String, default=lambda: utc_now().isoformat())
    updated_at: Mapped[str] = mapped_column(
        String,
        default=lambda: utc_now().isoformat(),
        onupdate=lambda: utc_now().isoformat(),
    )



class TaskORM(Base):
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    task_id: Mapped[str] = mapped_column(String, unique=True, index=True)
    name: Mapped[str] = mapped_column(String, default="", unique=True)
    description: Mapped[str] = mapped_column(Text, default="")
    current_version_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    group_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    created_at: Mapped[str] = mapped_column(String, default=lambda: utc_now().isoformat())
    updated_at: Mapped[str] = mapped_column(
        String,
        default=lambda: utc_now().isoformat(),
        onupdate=lambda: utc_now().isoformat(),
    )


class TaskVersionORM(Base):
    __tablename__ = "task_versions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    task_version_id: Mapped[str] = mapped_column(String, unique=True, index=True)
    task_id: Mapped[str] = mapped_column(String, index=True)
    version_label: Mapped[str] = mapped_column(String, default="v1")
    parent_version_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    system_prompt: Mapped[str] = mapped_column(Text, default="")
    user_template: Mapped[str] = mapped_column(Text, default="")
    prompt_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    prompt_version_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    provider_config_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    model_id: Mapped[str] = mapped_column(String, index=True)
    model_parameters: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    output_contract: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    image_preprocess_config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    image_slot_specs: Mapped[list[dict]] = mapped_column(JSON, default=list)
    variable_specs: Mapped[list[dict]] = mapped_column(JSON, default=list)
    pricing_profile_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[str] = mapped_column(String, default=lambda: utc_now().isoformat())
    updated_at: Mapped[str] = mapped_column(
        String,
        default=lambda: utc_now().isoformat(),
        onupdate=lambda: utc_now().isoformat(),
    )

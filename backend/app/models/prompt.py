"""ORM models for prompts and prompt versions."""

from __future__ import annotations

from sqlalchemy import JSON, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.schemas.common import utc_now


class PromptORM(Base):
    __tablename__ = "prompts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    prompt_id: Mapped[str] = mapped_column(String, unique=True, index=True)
    name: Mapped[str] = mapped_column(String, default="")
    description: Mapped[str] = mapped_column(Text, default="")
    current_version_id: Mapped[str | None] = mapped_column(String, nullable=True)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    created_at: Mapped[str] = mapped_column(String, default=lambda: utc_now().isoformat())
    updated_at: Mapped[str] = mapped_column(String, default=lambda: utc_now().isoformat())


class PromptVersionORM(Base):
    __tablename__ = "prompt_versions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    prompt_version_id: Mapped[str] = mapped_column(String, unique=True, index=True)
    prompt_id: Mapped[str] = mapped_column(String, index=True)
    version_label: Mapped[str] = mapped_column(String, default="v1")
    parent_version_id: Mapped[str | None] = mapped_column(String, nullable=True)

    system_prompt: Mapped[str] = mapped_column(Text, default="")
    user_template: Mapped[str] = mapped_column(Text, default="")
    format_instruction: Mapped[str] = mapped_column(Text, default="")
    notes: Mapped[str] = mapped_column(Text, default="")
    image_slot_specs: Mapped[list[dict]] = mapped_column(JSON, default=list)
    few_shot_examples: Mapped[list[dict]] = mapped_column(JSON, default=list)

    created_at: Mapped[str] = mapped_column(String, default=lambda: utc_now().isoformat())
    updated_at: Mapped[str] = mapped_column(String, default=lambda: utc_now().isoformat())

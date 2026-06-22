"""ORM model for saved Lab Tasks."""

from __future__ import annotations

from typing import Any

from sqlalchemy import Boolean, JSON, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.schemas.common import utc_now


class TaskORM(Base):
    __tablename__ = "tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    task_id: Mapped[str] = mapped_column(String, unique=True, index=True)
    name: Mapped[str] = mapped_column(String, default="")
    provider_config_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    model_id: Mapped[str] = mapped_column(String, index=True)
    model_parameters: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    system_prompt: Mapped[str] = mapped_column(Text, default="")
    user_prompt: Mapped[str] = mapped_column(Text, default="")
    format_instruction: Mapped[str] = mapped_column(Text, default="")
    output_contract: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    pricing_profile_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    image_resolution_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    image_resolution_target: Mapped[int] = mapped_column(Integer, default=1024)
    sample_set_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[str] = mapped_column(String, default=lambda: utc_now().isoformat())
    updated_at: Mapped[str] = mapped_column(
        String,
        default=lambda: utc_now().isoformat(),
        onupdate=lambda: utc_now().isoformat(),
    )

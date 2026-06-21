"""ORM models for model configs."""

from __future__ import annotations

from typing import Any

from sqlalchemy import JSON, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.schemas.common import utc_now


class ModelConfigORM(Base):
    __tablename__ = "model_configs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    model_config_id: Mapped[str] = mapped_column(String, unique=True, index=True)
    name: Mapped[str] = mapped_column(String, default="")
    provider_id: Mapped[str] = mapped_column(String, index=True)
    model_id: Mapped[str] = mapped_column(String, index=True)
    adapter_id: Mapped[str] = mapped_column(String, default="openai_compat")
    parameters: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    provider_options: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[str] = mapped_column(String, default=lambda: utc_now().isoformat())
    updated_at: Mapped[str] = mapped_column(String, default=lambda: utc_now().isoformat())

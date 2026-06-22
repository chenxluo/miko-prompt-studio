"""ORM model for provider configs."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.schemas.common import utc_now


class ProviderConfigORM(Base):
    """A configured provider endpoint (adapter + base_url + encrypted key)."""

    __tablename__ = "provider_configs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    provider_config_id: Mapped[str] = mapped_column(String, unique=True, index=True)
    name: Mapped[str] = mapped_column(String, default="")
    adapter_id: Mapped[str] = mapped_column(String, default="openai")
    base_url: Mapped[str | None] = mapped_column(String, nullable=True)
    api_key_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    cached_models: Mapped[list[str]] = mapped_column(JSON, default=list)
    selected_models: Mapped[list[str]] = mapped_column(JSON, default=list)
    models_cached_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[str] = mapped_column(
        String, default=lambda: utc_now().isoformat()
    )
    updated_at: Mapped[str] = mapped_column(
        String, default=lambda: utc_now().isoformat()
    )

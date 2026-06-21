"""ORM model for the key-value settings store (API keys, preferences, etc.)."""

from __future__ import annotations

from typing import Any

from sqlalchemy import JSON, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.schemas.common import utc_now


class SettingORM(Base):
    """Simple key-value store for app-level settings.

    Encrypted blobs (API keys) are stored here as ciphertext strings.
    """

    __tablename__ = "settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column(String, unique=True, index=True)
    value: Mapped[str] = mapped_column(Text, default="")
    value_json: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    category: Mapped[str] = mapped_column(String, default="general", index=True)
    updated_at: Mapped[str] = mapped_column(
        String, default=lambda: utc_now().isoformat()
    )

"""ORM models for pricing profiles."""

from __future__ import annotations

from typing import Any

from sqlalchemy import JSON, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.schemas.common import utc_now


class PricingProfileORM(Base):
    __tablename__ = "pricing_profiles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    pricing_profile_id: Mapped[str] = mapped_column(String, unique=True, index=True)
    provider_id: Mapped[str] = mapped_column(String, index=True)
    provider_config_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    model_id: Mapped[str] = mapped_column(String, index=True)
    currency: Mapped[str] = mapped_column(String, default="USD")
    effective_date: Mapped[str | None] = mapped_column(String, nullable=True)

    input_token_price: Mapped[float] = mapped_column(Float, default=0.0)
    output_token_price: Mapped[float] = mapped_column(Float, default=0.0)
    cached_input_price: Mapped[float | None] = mapped_column(Float, nullable=True)
    batch_discount: Mapped[float] = mapped_column(Float, default=1.0)

    image_pricing: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[str] = mapped_column(String, default=lambda: utc_now().isoformat())
    updated_at: Mapped[str] = mapped_column(String, default=lambda: utc_now().isoformat())

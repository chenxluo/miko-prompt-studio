"""Pricing Profile and cost-related schemas.

Mirrors section 8.7 of 设计文档.md.

Every Run saves a pricing *snapshot* so that historical cost figures stay
consistent even if the live pricing profile is later edited.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from pydantic import BaseModel, Field

from app.schemas.common import TimestampedModel


class ImagePriceMode(BaseModel):
    """How images are billed by a provider.

    Common modes:
    - ``token``   – images are converted to tokens and billed at
                    ``image_token_price``.
    - ``per_request`` – a flat per-image fee on top of text tokens.
    """

    mode: str = "token"  # "token" | "per_request" | "none"
    image_token_price: float | None = None       # per million tokens
    image_per_request_price: float | None = None  # flat per image


class PricingProfile(TimestampedModel):
    """Editable price table for a single provider + model."""

    pricing_profile_id: str
    provider_id: str
    provider_config_id: str | None = None
    model_id: str
    currency: str = "USD"
    effective_date: date | None = None

    # Token prices (per million tokens)
    input_token_price: float = 0.0
    output_token_price: float = 0.0
    cached_input_price: float | None = None
    batch_discount: float = 1.0  # 1.0 = no discount; 0.5 = 50% off

    image_pricing: ImagePriceMode = Field(default_factory=ImagePriceMode)
    notes: str = ""


class PricingSnapshot(BaseModel):
    """Frozen copy of a pricing profile stored in a Run Session/Item."""

    pricing_profile_id: str | None = None
    currency: str = "USD"
    input_token_price: float = 0.0
    output_token_price: float = 0.0
    cached_input_price: float | None = None
    batch_discount: float = 1.0
    image_pricing: ImagePriceMode = Field(default_factory=ImagePriceMode)
    raw: dict[str, Any] | None = None


class CostBreakdown(BaseModel):
    """Itemised cost for a single Run Item."""

    input_text: float = 0.0
    output_text: float = 0.0
    image_input: float = 0.0
    cached_input: float = 0.0
    retry_extra: float = 0.0


class CostEstimate(BaseModel):
    """Full cost record attached to a Run Item."""

    estimated_cost: float = 0.0
    actual_cost: float | None = None
    currency: str = "USD"
    pricing_profile_id: str | None = None
    pricing_snapshot: PricingSnapshot | None = None
    cost_breakdown: CostBreakdown = Field(default_factory=CostBreakdown)

"""ORM models for run sessions, run items, and attempts.

The Run Record is a three-layer structure (Session → Item → Attempt).
We flatten this into three tables with JSON columns for the rich nested
data, and indexed scalar columns for common queries (status, provider,
model, cost, rating, created_at).
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import JSON, Float, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.schemas.common import utc_now


class RunSessionORM(Base):
    __tablename__ = "run_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(String, unique=True, index=True)
    run_type: Mapped[str] = mapped_column(String, default="lab", index=True)
    name: Mapped[str] = mapped_column(String, default="")
    status: Mapped[str] = mapped_column(String, default="created", index=True)
    started_at: Mapped[str | None] = mapped_column(String, nullable=True)
    completed_at: Mapped[str | None] = mapped_column(String, nullable=True)

    source: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    config_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    summary: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    notes: Mapped[str] = mapped_column(Text, default="")

    created_at: Mapped[str] = mapped_column(String, default=lambda: utc_now().isoformat(), index=True)
    updated_at: Mapped[str] = mapped_column(String, default=lambda: utc_now().isoformat())


class RunItemORM(Base):
    __tablename__ = "run_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_item_id: Mapped[str] = mapped_column(String, unique=True, index=True)
    run_id: Mapped[str] = mapped_column(String, index=True)
    sample_id: Mapped[str] = mapped_column(String, index=True)
    status: Mapped[str] = mapped_column(String, default="pending", index=True)

    started_at: Mapped[str | None] = mapped_column(String, nullable=True)
    completed_at: Mapped[str | None] = mapped_column(String, nullable=True)

    # Rich nested data stored as JSON
    internal_request_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    prompt_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    model_config_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    output_contract_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    pricing_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)

    final_attempt_id: Mapped[str | None] = mapped_column(String, nullable=True)
    response: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    usage: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    cost: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    review: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    error: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    compare_axes: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)

    # Indexed scalar fields for fast queries
    provider_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    model_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    estimated_cost: Mapped[float] = mapped_column(Float, default=0.0)
    rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    accepted: Mapped[bool | None] = mapped_column(Integer, nullable=True)  # 0/1/NULL

    created_at: Mapped[str] = mapped_column(String, default=lambda: utc_now().isoformat(), index=True)
    updated_at: Mapped[str] = mapped_column(String, default=lambda: utc_now().isoformat())


class AttemptORM(Base):
    __tablename__ = "attempts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    attempt_id: Mapped[str] = mapped_column(String, unique=True, index=True)
    run_item_id: Mapped[str] = mapped_column(String, index=True)
    attempt_index: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String, default="pending", index=True)

    started_at: Mapped[str | None] = mapped_column(String, nullable=True)
    completed_at: Mapped[str | None] = mapped_column(String, nullable=True)

    provider_id: Mapped[str | None] = mapped_column(String, nullable=True)
    adapter_id: Mapped[str | None] = mapped_column(String, nullable=True)
    model_id: Mapped[str | None] = mapped_column(String, nullable=True)

    provider_request_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    provider_response_raw: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    normalized_response: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    usage: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    error: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)

    created_at: Mapped[str] = mapped_column(String, default=lambda: utc_now().isoformat())

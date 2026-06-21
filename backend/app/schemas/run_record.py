"""Run Record – the execution audit trail.

Mirrors section 3 of 文件格式文档.md.

Three-layer structure::

    Run Session   (one logical run: lab / batch / compare)
      └── Run Item     (one sample × one config)
            └── Attempt     (one actual API call; retries create multiple)

Every Run saves *snapshots* of prompt, model config, output contract, and
pricing so that history stays reproducible even when the live objects are
later edited.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from app.schemas.common import (
    AttemptStatus,
    ErrorType,
    NormalizedError,
    ParseStatus,
    RunItemType,
    RunSessionStatus,
    RunType,
    TimestampedModel,
    utc_now,
)
from app.schemas.internal_request import InternalRequest
from app.schemas.model_config import ModelConfigSnapshot
from app.schemas.output_contract import OutputContract
from app.schemas.pricing import CostEstimate, PricingSnapshot
from app.schemas.prompt import PromptSnapshot


# ---------------------------------------------------------------------------
# Run Session
# ---------------------------------------------------------------------------

class RunSource(BaseModel):
    """Where the samples for this run came from."""

    mode: str = "lab"  # lab | batch | compare
    sample_set_id: str | None = None
    sample_ids: list[str] = Field(default_factory=list)


class ConfigSnapshot(BaseModel):
    """Frozen configuration attached to a Run Session.

    Individual Run Items may override fields (e.g. in compare mode where
    each item uses a different prompt/model).
    """

    prompt_version: PromptSnapshot | None = None
    model_config_snapshot: ModelConfigSnapshot | None = None
    output_contract: OutputContract | None = None
    preprocess_config: dict[str, Any] | None = None
    pricing_profile: PricingSnapshot | None = None


class RunSummary(BaseModel):
    """Aggregate metrics for a Run Session, updated as items complete."""

    total_items: int = 0
    succeeded_items: int = 0
    failed_items: int = 0
    cancelled_items: int = 0
    skipped_items: int = 0
    total_attempts: int = 0
    total_cost_estimated: float = 0.0
    currency: str = "USD"
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_image_count: int = 0


class RunSession(TimestampedModel):
    """A single logical run (lab, batch, or compare)."""

    schema_version: str = "run_session.v1"
    run_id: str
    run_type: RunType = RunType.LAB
    name: str = ""
    status: RunSessionStatus = RunSessionStatus.CREATED
    started_at: datetime | None = None
    completed_at: datetime | None = None
    source: RunSource = Field(default_factory=RunSource)
    config_snapshot: ConfigSnapshot = Field(default_factory=ConfigSnapshot)
    summary: RunSummary = Field(default_factory=RunSummary)
    notes: str = ""


# ---------------------------------------------------------------------------
# Usage & Response (shared between Run Item and Attempt)
# ---------------------------------------------------------------------------

class Usage(BaseModel):
    """Token / image usage for a single request.

    Supports both provider-reported and estimated usage.  When the
    provider does not return usage, ``estimated`` is set to ``True`` and
    the values are computed heuristically.
    """

    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    image_count: int = 0
    image_tokens: int | None = None
    cached_input_tokens: int | None = None
    provider_reported: bool = True
    estimated: bool = False
    raw_usage: dict[str, Any] | None = None


class SafetyInfo(BaseModel):
    blocked: bool = False
    categories: list[str] = Field(default_factory=list)
    raw: dict[str, Any] | None = None


class NormalizedResponse(BaseModel):
    """Provider response after adapter normalisation (before parsing)."""

    text: str = ""
    finish_reason: str | None = None
    safety: SafetyInfo = Field(default_factory=SafetyInfo)


class ParsedResponse(BaseModel):
    """The parsed view of a model response."""

    raw_text: str = ""
    parsed: Any = None
    parse_status: ParseStatus = ParseStatus.NOT_PARSED
    parse_errors: list[dict[str, Any]] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Attempt (one actual API call)
# ---------------------------------------------------------------------------

class AdapterInfo(BaseModel):
    provider_id: str
    adapter_id: str
    model_id: str


class Attempt(BaseModel):
    """A single API call.  Retries produce multiple attempts per Run Item."""

    schema_version: str = "attempt.v1"
    attempt_id: str
    run_item_id: str
    attempt_index: int = 0
    status: AttemptStatus = AttemptStatus.PENDING
    started_at: datetime | None = None
    completed_at: datetime | None = None
    adapter: AdapterInfo | None = None
    provider_request_snapshot: dict[str, Any] | None = None  # redacted
    provider_response_raw: dict[str, Any] | None = None
    normalized_response: NormalizedResponse | None = None
    usage: Usage | None = None
    error: NormalizedError | None = None
    latency_ms: int | None = None


# ---------------------------------------------------------------------------
# Review (lightweight human evaluation)
# ---------------------------------------------------------------------------

BUILTIN_REVIEW_LABELS = frozenset(
    {
        "good",
        "bad",
        "needs_revision",
        "refusal",
        "hallucination",
        "missing_detail",
        "format_error",
        "too_verbose",
        "too_short",
        "wrong_image_order",
        "wrong_role_reference",
        "safety_overrefusal",
    }
)


class Review(BaseModel):
    """Optional human review attached to a Run Item."""

    accepted: bool | None = None
    rating: int | None = None  # 1-5
    labels: list[str] = Field(default_factory=list)
    notes: str = ""
    reviewed_at: datetime | None = None


# ---------------------------------------------------------------------------
# Run Item (one sample × one config inside a Run Session)
# ---------------------------------------------------------------------------

class RunItemExportInfo(BaseModel):
    exportable: bool = True
    export_status: str = "not_exported"  # not_exported | exported | skipped


class CompareAxes(BaseModel):
    """Extra dimensions recorded in compare mode for matrix display."""

    prompt_version_id: str | None = None
    model_config_id: str | None = None


class RunItem(TimestampedModel):
    """One sample's result within a Run Session."""

    schema_version: str = "run_item.v1"
    run_item_id: str
    run_id: str
    sample_id: str
    status: RunItemType = RunItemType.PENDING
    started_at: datetime | None = None
    completed_at: datetime | None = None

    # Snapshot of the Internal Request that produced this item.
    internal_request_snapshot: dict[str, Any] | None = None

    final_attempt_id: str | None = None
    response: ParsedResponse = Field(default_factory=ParsedResponse)
    usage: Usage = Field(default_factory=Usage)
    cost: CostEstimate = Field(default_factory=CostEstimate)
    review: Review = Field(default_factory=Review)
    export: RunItemExportInfo = Field(default_factory=RunItemExportInfo)
    compare_axes: CompareAxes | None = None

    # Filled when status == failed
    error: NormalizedError | None = None


# ---------------------------------------------------------------------------
# Adapter result (returned by a provider adapter, before persistence)
# ---------------------------------------------------------------------------

class AdapterResult(BaseModel):
    """What a provider adapter returns after a single API call.

    The Run Executor transforms this into an :class:`Attempt` and, if it
    is the final attempt, into the ``response`` / ``usage`` / ``cost``
    fields of a :class:`RunItem`.
    """

    status: AttemptStatus
    normalized_response: NormalizedResponse | None = None
    usage: Usage | None = None
    error: NormalizedError | None = None
    latency_ms: int | None = None
    provider_request_snapshot: dict[str, Any] | None = None  # redacted
    provider_response_raw: dict[str, Any] | None = None

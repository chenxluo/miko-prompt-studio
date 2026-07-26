"""Shared scalar / enum types and helpers used across schemas."""

from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


def utc_now() -> datetime:
    """Return timezone-aware UTC now."""
    return datetime.now(timezone.utc)


class TimestampedModel(BaseModel):
    """Mixin that adds created_at / updated_at with sensible defaults."""

    model_config = ConfigDict(from_attributes=True)

    created_at: datetime = Field(default_factory=utc_now)
    updated_at: datetime = Field(default_factory=utc_now)


# ---------------------------------------------------------------------------
# Sample types (soft – not a hard enum, but we provide common values)
# ---------------------------------------------------------------------------

SAMPLE_TYPES = frozenset({"single_image", "multi_image", "edit_pair", "image_group", "custom"})


# ---------------------------------------------------------------------------
# Output contract modes
# ---------------------------------------------------------------------------


class OutputMode(str, Enum):
    FREE_TEXT = "free_text"
    SOFT_SECTIONS = "soft_sections"
    LOOSE_JSON = "loose_json"
    STRICT_JSON = "strict_json"
    CUSTOM = "custom"


# ---------------------------------------------------------------------------
# URL image transport policy (shared contract)
# ---------------------------------------------------------------------------


class UrlImageTransport(str, Enum):
    """Policy chosen by the caller for delivering URL-sourced images.

    - ``auto``    – direct URL for supported schemes/providers when local
                    preprocessing is OFF, otherwise securely download and
                    embed inline.
    - ``direct``  – backend must NOT fetch the URL; the adapter decides
                    between ``fileData.fileUri`` (Vertex) and ``image_url``
                    (OpenAI-compat). Preprocessing + unsupported schemes
                    surface as non-retryable capability errors.
    - ``inline``  – always securely download via the existing materializer
                    and embed the bytes as inline image data. Preprocessing
                    is honored.
    """

    AUTO = "auto"
    DIRECT = "direct"
    INLINE = "inline"


class ImageTransportKind(str, Enum):
    """Effective transport recorded on a :class:`ResolvedImage` after
    capability/policy resolution. Independent of the user-facing policy."""

    DIRECT_URL = "direct_url"  # backend handed the URL to the adapter
    INLINE_DATA = "inline_data"  # backend downloaded + base64-embedded
    PROVIDER_URI = "provider_uri"  # provider-native URI (e.g. gs:// on Vertex)


# ---------------------------------------------------------------------------
# Run lifecycle statuses
# ---------------------------------------------------------------------------


class RunSessionStatus(str, Enum):
    CREATED = "created"
    RUNNING = "running"
    COMPLETED = "completed"
    COMPLETED_WITH_ERRORS = "completed_with_errors"
    CANCELLED = "cancelled"
    FAILED = "failed"


class RunItemType(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    SKIPPED = "skipped"


class AttemptStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    TIMEOUT = "timeout"
    RATE_LIMITED = "rate_limited"
    BLOCKED = "blocked"
    CANCELLED = "cancelled"


class ParseStatus(str, Enum):
    NOT_PARSED = "not_parsed"
    PARSED = "parsed"
    PARTIALLY_PARSED = "partially_parsed"
    PARSE_FAILED = "parse_failed"


class RunType(str, Enum):
    LAB = "lab"
    BATCH = "batch"
    COMPARE = "compare"
    RERUN_FAILED = "rerun_failed"
    IMPORT_TEST = "import_test"
    DRY_RUN = "dry_run"


# ---------------------------------------------------------------------------
# Error taxonomy (section 3.11 of 文件格式文档)
# ---------------------------------------------------------------------------


class ErrorType(str, Enum):
    AUTH_ERROR = "auth_error"
    RATE_LIMIT = "rate_limit"
    TIMEOUT = "timeout"
    NETWORK_ERROR = "network_error"
    PROVIDER_ERROR = "provider_error"
    INVALID_REQUEST = "invalid_request"
    UNSUPPORTED_CAPABILITY = "unsupported_capability"
    SAFETY_BLOCKED = "safety_blocked"
    EMPTY_RESPONSE = "empty_response"
    PARSE_ERROR = "parse_error"
    FORMAT_ERROR = "format_error"
    UNKNOWN_ERROR = "unknown_error"


RETRYABLE_ERROR_TYPES = frozenset(
    {ErrorType.RATE_LIMIT, ErrorType.TIMEOUT, ErrorType.NETWORK_ERROR}
)


class NormalizedError(BaseModel):
    """Provider-independent error representation."""

    type: ErrorType = ErrorType.UNKNOWN_ERROR
    message: str = ""
    provider_error_code: str | None = None
    retryable: bool = False
    raw_error: dict[str, Any] | None = None

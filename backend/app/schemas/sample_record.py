"""Sample Record schema – the data layer describing *what* a sample is.

Mirrors section 1 of 文件格式文档.md.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.common import TimestampedModel


class ImageMetadata(BaseModel):
    """Physical metadata of an image file (populated lazily)."""

    width: int | None = None
    height: int | None = None
    file_size: int | None = None
    sha256: str | None = None
    extra: dict[str, Any] = Field(default_factory=dict)


class ImageRef(BaseModel):
    """A single image reference inside a Sample Record.

    ``role`` is a soft label — the system never hard-codes a fixed set.
    Common preset values: target, source, before, after, reference,
    character_reference, style_reference, pose_reference, mask,
    control_image, candidate, frame.
    """

    model_config = ConfigDict(extra="allow")

    image_id: str | None = None
    role: str = "target"
    path: str | None = None
    uri: str | None = None  # data: URI or remote URL (when path is None)
    mime_type: str | None = None
    display_name: str | None = None
    order: int = 0
    metadata: ImageMetadata = Field(default_factory=ImageMetadata)


class SampleRecord(BaseModel):
    """A single test/annotation sample.

    Designed to be provider- and prompt-agnostic.  It only describes the
    sample itself: images, template variables, and auxiliary metadata.
    """

    model_config = ConfigDict(extra="allow")

    schema_version: str = "sample_record.v1"
    sample_id: str
    sample_type: str = "single_image"
    images: list[ImageRef] = Field(default_factory=list)
    vars: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    expected: dict[str, Any] | None = None
    tags: list[str] = Field(default_factory=list)
    notes: str = ""

    # Filled by the storage layer when the record is persisted.
    sample_set_id: str | None = None


class SampleSet(BaseModel):
    """A named collection of Sample Records (by reference)."""

    schema_version: str = "sample_set.v1"
    sample_set_id: str
    name: str
    description: str = ""
    import_source: dict[str, Any] | None = None
    record_ids: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class SampleMapping(BaseModel):
    """Runtime mapping from sample fields to a task version's expected IDs."""

    # task_var_id -> sample.vars key
    variable_mapping: dict[str, str] = Field(default_factory=dict)
    # task_role_hint -> sample.images[].role
    image_role_mapping: dict[str, str] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# ORM-facing model that flattens SampleRecord for storage
# ---------------------------------------------------------------------------

class SampleRecordORM(TimestampedModel):
    """Flat representation of a SampleRecord row in SQLite.

    The rich structure (images, vars, metadata, ...) is stored as JSON.
    """

    id: int | None = None
    sample_id: str
    sample_set_id: str | None = None
    sample_type: str = "single_image"
    data: dict[str, Any]  # full SampleRecord JSON
    tags: list[str] = Field(default_factory=list)
    notes: str = ""


class SampleSetORM(TimestampedModel):
    id: int | None = None
    sample_set_id: str
    name: str
    description: str = ""
    import_source: dict[str, Any] | None = None
    record_ids: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)

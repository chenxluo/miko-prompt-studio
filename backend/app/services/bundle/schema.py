"""Pydantic models for the bundle envelope."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

BUNDLE_FORMAT = "miko-prompt-studio-bundle"
BUNDLE_SCHEMA_VERSION = "1.0.0"


class BundleManifest(BaseModel):
    """Top-level metadata describing a bundle."""

    format: str = BUNDLE_FORMAT
    schema_version: str = BUNDLE_SCHEMA_VERSION
    generator: str = "miko-prompt-studio"
    generator_version: str | None = None
    min_app_version: str | None = None
    exported_at: str
    content_hash: str | None = None
    redacted: list[str] = Field(default_factory=list)
    excluded: list[str] = Field(default_factory=list)
    entity_counts: dict[str, int] = Field(default_factory=dict)


class BundleEntity(BaseModel):
    """A single exported entity (row) from the workspace."""

    kind: str
    payload_version: str
    id: str
    fields: dict[str, Any]


class BundleAsset(BaseModel):
    """An embedded binary asset (typically a local image file)."""

    id: str
    mime: str | None = None
    encoding: str = "base64"
    data: str | None = None
    filename: str | None = None
    source_path: str | None = None
    sha256: str | None = None


class BundleEnvelope(BaseModel):
    """The complete bundle: metadata + entities + optional assets."""

    manifest: BundleManifest
    entities: list[BundleEntity] = Field(default_factory=list)
    assets: list[BundleAsset] = Field(default_factory=list)

"""Lightweight curated bookmarks over existing run records."""

from __future__ import annotations

from typing import Any

from pydantic import Field

from app.schemas.common import TimestampedModel


class ResultSnapshot(TimestampedModel):
    snapshot_id: str
    run_id: str
    run_item_id: str | None = None
    attempt_id: str | None = None
    name: str = ""
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    starred: bool = False
    notes: str = ""
    accepted: bool | None = None
    rating: int | None = None
    provider_id: str | None = None
    model_id: str | None = None
    prompt_version_id: str | None = None
    thumbnail_image_uri: str | None = None

    # Full reproduction data.  These are optional in older snapshots; new
    # snapshots always populate them and copy referenced images into the
    # snapshot's own directory.
    internal_request_snapshot: dict[str, Any] | None = None
    config_snapshot: dict[str, Any] | None = None
    image_dir: str | None = None

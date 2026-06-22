"""Persist images referenced by run records into durable storage.

Run-time images live in transient directories (uploads, preprocessed cache).
Snapshots and prompt few-shot examples need their own durable copies so they
remain viewable after the original files are garbage-collected.
"""

from __future__ import annotations

import base64
import shutil
from pathlib import Path
from typing import Any
from uuid import uuid4


def _data_uri_to_bytes(uri: str) -> bytes | None:
    """Decode a data URI to raw bytes if it is one."""
    if not uri.startswith("data:"):
        return None
    header, _, body = uri.partition(",")
    if not body:
        return None
    is_base64 = ";base64" in header
    if is_base64:
        return base64.b64decode(body)
    return body.encode("utf-8")


def _ext_from_mime(mime_type: str | None, fallback: str = ".png") -> str:
    mapping = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/bmp": ".bmp",
    }
    return mapping.get(mime_type, fallback)


def _resolve_source_path(image: dict[str, Any]) -> Path | None:
    """Return a readable local path for the image if one exists."""
    resolved = image.get("resolved") or {}
    for key in ("path",):
        value = resolved.get(key)
        if value and isinstance(value, str):
            path = Path(value)
            if path.exists():
                return path
    # Fallback to the original path if available.
    path_value = image.get("path")
    if path_value and isinstance(path_value, str):
        path = Path(path_value)
        if path.exists():
            return path
    return None


def persist_request_images(
    images: list[dict[str, Any]],
    dest_dir: Path,
) -> list[dict[str, Any]]:
    """Copy/decode images into dest_dir and return updated image dicts.

    Each returned dict keeps the original structure but updates:
      - resolved.path -> absolute path inside dest_dir
      - resolved.uri  -> None (caller can rewrite to a serving URL)
      - path          -> absolute path inside dest_dir (best-effort)
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    persisted: list[dict[str, Any]] = []

    for index, image in enumerate(images):
        if not isinstance(image, dict):
            persisted.append(image)
            continue

        image = dict(image)
        resolved = dict(image.get("resolved") or {})
        mime_type = resolved.get("mime_type") or image.get("mime_type") or "image/png"
        source_path = _resolve_source_path(image)
        saved_name = f"img_{index:03d}_{uuid4().hex[:12]}{_ext_from_mime(mime_type)}"
        saved_path = dest_dir / saved_name

        if source_path is not None:
            shutil.copy2(source_path, saved_path)
        else:
            uri = resolved.get("uri") or image.get("uri")
            if isinstance(uri, str) and uri.startswith("data:"):
                data = _data_uri_to_bytes(uri)
                if data is not None:
                    saved_path.write_bytes(data)
            elif isinstance(uri, str) and uri.startswith("http"):
                # Remote URL: keep it, do not try to download here.
                persisted.append(image)
                continue
            else:
                # Nothing to persist.
                persisted.append(image)
                continue

        resolved["path"] = str(saved_path)
        resolved["uri"] = None
        resolved["mime_type"] = mime_type
        image["resolved"] = resolved
        image["path"] = str(saved_path)
        image["uri"] = None
        persisted.append(image)

    return persisted


def rewrite_image_uris(
    images: list[dict[str, Any]],
    base_uri: str,
) -> list[dict[str, Any]]:
    """Rewrite resolved.uri for locally persisted images to a serving URL."""
    rewritten: list[dict[str, Any]] = []
    for image in images:
        if not isinstance(image, dict):
            rewritten.append(image)
            continue
        image = dict(image)
        resolved = dict(image.get("resolved") or {})
        local_path = resolved.get("path") or image.get("path")
        if isinstance(local_path, str) and local_path:
            filename = Path(local_path).name
            resolved["uri"] = f"{base_uri}/{filename}"
            image["uri"] = f"{base_uri}/{filename}"
        image["resolved"] = resolved
        rewritten.append(image)
    return rewritten


def request_image_to_image_ref(image: dict[str, Any]) -> dict[str, Any]:
    """Convert a RequestImage dict to a minimal ImageRef dict.

    This is used when storing run results as few-shot examples: the example
    only needs the original reference and a viewable URI, not the full
    preprocessing strategy.
    """
    if not isinstance(image, dict):
        return image
    resolved = image.get("resolved") or {}
    return {
        "image_id": image.get("source_image_id") or image.get("request_image_id"),
        "role": image.get("role", "target"),
        "path": resolved.get("path") or image.get("path"),
        "uri": resolved.get("uri") or image.get("uri"),
        "mime_type": resolved.get("mime_type") or image.get("mime_type"),
        "display_name": None,
        "order": image.get("order", 0),
        "metadata": {
            "width": resolved.get("width"),
            "height": resolved.get("height"),
            "file_size": resolved.get("file_size"),
            "sha256": resolved.get("sha256"),
        },
    }

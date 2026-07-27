"""Scrub inline image byte payloads from JSON-serializable snapshots.

The DB-bloat/lock-contention root cause is that request snapshots embed full
base64 image data (``data:image/...;base64,...`` URIs, ``b64_json`` blobs,
large inline base64) that already lives on disk under ``uploads_dir``. This
module deep-walks a snapshot structure and replaces those byte payloads with
size placeholders, shrinking multi-MB snapshots to a few KB without losing
the surrounding metadata (paths, roles, mime types, transport kinds).

Used for:
  * ``attempts.provider_request_snapshot`` — a debug-only column, so a size
    placeholder is the correct representation (the bytes are redundant with the
    uploads and were never meant to be replayed verbatim).
  * (The frontend-visible ``run_items.internal_request_snapshot`` is NOT
    scrubbed in place — its ``resolved.uri`` is rewritten to a serving URL by
    the run executor so the UI keeps displaying images.)
"""
from __future__ import annotations

import copy
import re
from typing import Any

_BASE64_RE = re.compile(r"^[A-Za-z0-9+/=\s]+$")
_DATA_URI_BASE64_PREFIX = "data:"


def scrub_image_bytes(value: Any) -> Any:
    """Return a deep copy of ``value`` with inline image byte payloads replaced.

    Non-mutating. Handles arbitrarily nested dict/list structures.
    """
    return _scrub(value, parent_key=None, sibling_mime=None)


def _scrub(value: Any, parent_key: str | None, sibling_mime: str | None) -> Any:
    if isinstance(value, dict):
        mime = _sibling_mime(value) or sibling_mime
        return {
            k: (
                _scrub_string(k, v, mime)
                if isinstance(v, str)
                else _scrub(v, k.lower(), mime)
            )
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [
            (
                _scrub_string(parent_key, v, sibling_mime)
                if isinstance(v, str)
                else _scrub(v, None, sibling_mime)
            )
            for v in value
        ]
    return value


def _sibling_mime(value: dict[str, Any]) -> str | None:
    """Pick up a mimeType/mime_type hint from a sibling key, so short data URIs
    inside an image part still get scrubbed."""
    for key in ("mimeType", "mime_type"):
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


def _scrub_string(key: str | None, text: str, sibling_mime: str | None) -> str:
    if not isinstance(text, str) or not text:
        return text
    normalized_key = (key or "").lower()
    # Any ``data:...;base64,...`` string is an inline image payload; scrub
    # unconditionally regardless of key name or length.
    if text.startswith(_DATA_URI_BASE64_PREFIX) and ";base64," in text:
        return _placeholder(text)
    # Image base64 carried under a known content key — length-agnostic, catches
    # short payloads when a sibling mime says "image/*".
    if normalized_key in {"data", "b64_json"} and _looks_like_image_payload(
        text, sibling_mime
    ):
        return f"<redacted {len(text)}-char image base64>"
    if normalized_key == "b64_json":
        return f"<redacted {len(text)}-char b64_json>"
    return text


def _looks_like_image_payload(text: str, sibling_mime: str | None) -> bool:
    if not text:
        return False
    if text.startswith("data:image/"):
        return True
    if sibling_mime and sibling_mime.lower().startswith("image/"):
        return True
    # Only treat long, base64-shaped strings as image data; short tokens are not
    # worth scrubbing on a generic ``data`` key.
    if len(text) < 256 or len(text) > 5_000_000:
        return False
    return bool(_BASE64_RE.match(text))


def _placeholder(text: str) -> str:
    """Replace a ``data:...;base64,<payload>`` URI with a size placeholder,
    preserving the mime prefix for debuggability."""
    head, _, payload = text.partition(";base64,")
    if not payload:
        return head
    return f"{head};base64,<redacted {len(payload)}-char base64>"


def rewrite_inline_image_uris(snapshot: Any, run_item_id: str) -> Any:
    """Replace inline ``data:`` image URIs in a snapshot with a serving URL.

    The frontend displays run-item input images from ``images[].resolved.uri``.
    For inline transport that URI is a multi-MB base64 ``data:`` string (the
    DB-bloat source). Here it is rewritten to ``/api/run-items/{id}/images/{i}``
    — a URL the frontend already knows how to fetch — and the bytes are dropped
    from the snapshot. Only images that have a servable local ``path`` (so the
    endpoint can serve the file) are rewritten; URL/direct-transport URIs and
    path-less images are left untouched.
    """
    if not isinstance(snapshot, dict) or not run_item_id:
        return snapshot

    out = copy.deepcopy(snapshot)
    for index, image in enumerate(out.get("images") or []):
        if not isinstance(image, dict):
            continue
        resolved = image.get("resolved")
        if not isinstance(resolved, dict):
            continue
        uri = resolved.get("uri")
        if (
            isinstance(uri, str)
            and uri.startswith(_DATA_URI_BASE64_PREFIX)
            and ";base64," in uri
            and image.get("path")
        ):
            resolved["uri"] = f"/api/run-items/{run_item_id}/images/{index}"
    return out


def retarget_image_uris(
    snapshot: Any, old_run_item_id: str, new_run_item_id: str
) -> Any:
    """Re-point ``/api/run-items/{old}/images/{i}`` URLs to a new run_item_id.

    The matrix executor runs each cell through a throwaway temp run_item, then
    copies the result onto the real matrix item. The image serving URLs baked
    into the snapshot reference the temp id; after the copy they must point at
    the final id or the images 404.
    """
    if (
        not isinstance(snapshot, dict)
        or not old_run_item_id
        or not new_run_item_id
        or old_run_item_id == new_run_item_id
    ):
        return snapshot

    old_prefix = f"/api/run-items/{old_run_item_id}/images/"
    new_prefix = f"/api/run-items/{new_run_item_id}/images/"
    out = copy.deepcopy(snapshot)
    for image in out.get("images") or []:
        if not isinstance(image, dict):
            continue
        resolved = image.get("resolved")
        if (
            isinstance(resolved, dict)
            and isinstance(resolved.get("uri"), str)
            and resolved["uri"].startswith(old_prefix)
        ):
            resolved["uri"] = new_prefix + resolved["uri"][len(old_prefix):]
    return out

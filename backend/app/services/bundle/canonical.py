"""Canonical JSON serialization and content hashing for bundles.

The canonical form guarantees that the same logical content always produces the
same byte sequence, independent of Python dict insertion order or JSON pretty
printing.  This is used for the bundle content-hash integrity check.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any


def canonical_json(obj: Any) -> str:
    """Return a deterministic, compact JSON representation of ``obj``.

    Dict keys are sorted recursively.  Lists of dicts that contain an ``id``
    key are sorted by that key so that the hash is stable across reorderings.
    """

    def _transform(value: Any) -> Any:
        if isinstance(value, dict):
            return {k: _transform(v) for k, v in sorted(value.items())}
        if isinstance(value, list):
            if value and isinstance(value[0], dict):
                first: dict = value[0]
                if "id" in first:
                    try:
                        sorted_list = sorted(
                            value,
                            key=lambda x: str(x.get("id")) if isinstance(x, dict) else "",
                        )
                        return [_transform(v) for v in sorted_list]
                    except TypeError:
                        pass
            return [_transform(v) for v in value]
        return value

    return json.dumps(
        _transform(obj),
        ensure_ascii=False,
        separators=(",", ":"),
    )


def content_hash(entities: list[dict], assets: list[dict]) -> str:
    """Return a stable SHA-256 content hash for an entity/asset payload.

    Asset byte payloads are represented by their own SHA-256 digests so that
    the content hash does not depend on base64 whitespace or encoding.
    """
    assets_for_hash: list[dict[str, Any]] = sorted(
        [
            {
                "id": a["id"],
                "sha256": a.get("sha256"),
                "mime": a.get("mime"),
            }
            for a in assets
        ],
        key=lambda a: a["id"],
    )
    entities_for_hash = sorted(entities, key=lambda e: (e["kind"], e["id"]))
    payload = {"entities": entities_for_hash, "assets": assets_for_hash}
    return "sha256:" + hashlib.sha256(canonical_json(payload).encode()).hexdigest()

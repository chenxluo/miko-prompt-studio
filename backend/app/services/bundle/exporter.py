"""Bundle exporter: gather entities by scope, build envelope, write file."""

from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.common import utc_now

from .canonical import content_hash
from .schema import BundleAsset, BundleEntity, BundleEnvelope, BundleManifest
from .serialize import REGISTRY, EntitySpec, to_bundle_entity


@dataclass
class ExportScope:
    """Which workspace entities to include in the bundle."""

    task_ids: list[str] = field(default_factory=list)
    sample_set_ids: list[str] = field(default_factory=list)
    prompt_ids: list[str] = field(default_factory=list)
    provider_config_ids: list[str] = field(default_factory=list)
    all_: bool = False


@dataclass
class ExportOptions:
    """Options controlling bundle content and format."""

    include_assets: bool = True
    include_samples: bool = False


def _is_uri(value: str) -> bool:
    return value.startswith(("http://", "https://", "data:"))


def _ext_from_mime(mime: str | None) -> str:
    if mime:
        ext = mimetypes.guess_extension(mime)
        if ext:
            return ext
    return ".bin"


def _asset_id_from_sha(sha: str) -> str:
    return f"asset_{sha[:12]}"


async def _load_by_ids(db: AsyncSession, spec: EntitySpec, ids: list[str]) -> list[Any]:
    if not ids:
        return []
    key_attr = getattr(spec.orm, spec.key_col)
    return list(
        (await db.execute(select(spec.orm).where(key_attr.in_(ids)))).scalars().all()
    )


async def _expand_task_versions(db: AsyncSession, task_id: str) -> list[Any]:
    tv_spec = REGISTRY["task_version"]
    return list(
        (await db.execute(select(tv_spec.orm).where(tv_spec.orm.task_id == task_id)))
        .scalars()
        .all()
    )


async def _expand_sample_records(db: AsyncSession, sample_set_id: str) -> list[Any]:
    sr_spec = REGISTRY["sample_record"]
    records = list(
        (await db.execute(select(sr_spec.orm).where(sr_spec.orm.sample_set_id == sample_set_id)))
        .scalars()
        .all()
    )
    # Also pull records referenced by sample_set.record_ids even if they are not
    # currently linked by sample_set_id.
    ss_spec = REGISTRY["sample_set"]
    ss = (
        await db.execute(
            select(ss_spec.orm).where(getattr(ss_spec.orm, ss_spec.key_col) == sample_set_id)
        )
    ).scalar_one_or_none()
    if ss:
        record_ids = ss.record_ids or []
        if record_ids:
            extra = list(
                (
                    await db.execute(
                        select(sr_spec.orm).where(sr_spec.orm.sample_id.in_(record_ids))
                    )
                )
                .scalars()
                .all()
            )
            seen = {r.sample_id for r in records}
            for r in extra:
                if r.sample_id not in seen:
                    records.append(r)
    return records


async def _gather_entities(
    db: AsyncSession, scope: ExportScope
) -> dict[str, dict[str, Any]]:
    """Collect all entities reachable from the export scope.

    Returns a dict of ``kind -> {business_id: orm_row}``.
    """
    collected: dict[str, dict[str, Any]] = {kind: {} for kind in REGISTRY}

    if scope.all_:
        for spec in REGISTRY.values():
            rows = (await db.execute(select(spec.orm))).scalars().all()
            for row in rows:
                collected[spec.kind][getattr(row, spec.key_col)] = row
    else:
        seeds = [
            ("task", scope.task_ids),
            ("sample_set", scope.sample_set_ids),
            ("prompt", scope.prompt_ids),
            ("provider_config", scope.provider_config_ids),
        ]
        for kind, ids in seeds:
            if ids:
                spec = REGISTRY[kind]
                for row in await _load_by_ids(db, spec, ids):
                    collected[kind][getattr(row, spec.key_col)] = row

        # Expand task seeds to their versions.
        for task_id in scope.task_ids:
            for v in await _expand_task_versions(db, task_id):
                collected["task_version"][v.task_version_id] = v

        # Expand sample-set seeds to their records.
        for ss_id in scope.sample_set_ids:
            for r in await _expand_sample_records(db, ss_id):
                collected["sample_record"][r.sample_id] = r

    # BFS over FK references and child collections until a fixed point.
    while True:
        changed = False

        # Any task in the collection brings in its full version list.
        for task_id in list(collected["task"].keys()):
            for v in await _expand_task_versions(db, task_id):
                if v.task_version_id not in collected["task_version"]:
                    collected["task_version"][v.task_version_id] = v
                    changed = True

        # Any sample-set in the collection brings in its full record list.
        for ss_id in list(collected["sample_set"].keys()):
            for r in await _expand_sample_records(db, ss_id):
                if r.sample_id not in collected["sample_record"]:
                    collected["sample_record"][r.sample_id] = r
                    changed = True

        # Walk declared FK columns and fetch missing target rows.
        for kind, spec in REGISTRY.items():
            for row in list(collected[kind].values()):
                for fk_attr, target_kind in spec.fk_cols.items():
                    fk_value = getattr(row, fk_attr)
                    if fk_value is None or fk_value in collected[target_kind]:
                        continue
                    target_spec = REGISTRY[target_kind]
                    target = (
                        await db.execute(
                            select(target_spec.orm).where(
                                getattr(target_spec.orm, target_spec.key_col) == fk_value
                            )
                        )
                    ).scalar_one_or_none()
                    if target:
                        collected[target_kind][fk_value] = target
                        changed = True

        if not changed:
            break

    return collected


def _collect_assets(entity_dicts: list[dict], warnings: list[str]) -> list[dict]:
    """Embed local image files referenced by sample records as bundle assets.

    Rewrites the sample record ``data.images[].path`` to ``bundle:{asset_id}``
    for successfully bundled files.  Files that cannot be read are left as-is
    and a warning is recorded.
    """
    assets: list[dict] = []
    asset_by_sha: dict[str, str] = {}

    for entity in entity_dicts:
        if entity["kind"] != "sample_record":
            continue
        data = entity["fields"].get("data") or {}
        images = data.get("images") or []
        for img in images:
            path = img.get("path")
            if not path or isinstance(path, str) and (_is_uri(path) or path.startswith("bundle:")):
                continue
            file_path = Path(path)
            if not file_path.is_file():
                warnings.append(
                    f"sample_record:{entity['id']}: image file not found: {path}"
                )
                continue
            content = file_path.read_bytes()
            sha = hashlib.sha256(content).hexdigest()
            if sha in asset_by_sha:
                img["path"] = f"bundle:{asset_by_sha[sha]}"
                continue
            asset_id = _asset_id_from_sha(sha)
            asset_by_sha[sha] = asset_id
            mime, _ = mimetypes.guess_type(str(file_path))
            if mime is None:
                mime = "application/octet-stream"
            assets.append(
                {
                    "id": asset_id,
                    "mime": mime,
                    "encoding": "base64",
                    "data": base64.b64encode(content).decode("ascii"),
                    "filename": None,
                    "source_path": str(file_path),
                    "sha256": sha,
                }
            )
            img["path"] = f"bundle:{asset_id}"

    return assets


async def export_bundle(
    db: AsyncSession, scope: ExportScope, options: ExportOptions
) -> BundleEnvelope:
    """Build a :class:`BundleEnvelope` from the database for the given scope."""
    collected = await _gather_entities(db, scope)

    stable_order = list(REGISTRY.keys())
    entity_dicts: list[dict] = []
    for kind in stable_order:
        spec = REGISTRY[kind]
        for key_id in sorted(collected[kind].keys()):
            row = collected[kind][key_id]
            entity = to_bundle_entity(row, spec)
            entity_dicts.append(entity.model_dump(mode="json"))

    warnings: list[str] = []
    asset_dicts: list[dict] = []
    if options.include_assets:
        asset_dicts = _collect_assets(entity_dicts, warnings)

    entities = [BundleEntity.model_validate(e) for e in entity_dicts]
    assets = [BundleAsset.model_validate(a) for a in asset_dicts]

    entity_counts = Counter(e["kind"] for e in entity_dicts)

    redacted: list[str] = []
    if entity_counts.get("provider_config", 0):
        redacted = [
            "provider_config.api_key_encrypted",
            "provider_config.base_url",
            "provider_config.models_cached_at",
        ]
    excluded = ["settings(api_keys)", "runs/run_items/attempts/result_snapshots"]

    manifest = BundleManifest(
        exported_at=utc_now().isoformat(),
        content_hash=content_hash(entity_dicts, asset_dicts),
        redacted=redacted,
        excluded=excluded,
        entity_counts=dict(entity_counts),
    )

    return BundleEnvelope(manifest=manifest, entities=entities, assets=assets)


def write_bundle(envelope: BundleEnvelope, path: str | Path) -> Path:
    """Write ``envelope`` to ``path`` as JSON or a ZIP archive."""
    path = Path(path)

    if not envelope.assets:
        with path.open("w", encoding="utf-8") as f:
            json.dump(
                envelope.model_dump(mode="json"),
                f,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
        return path

    if path.suffix != ".zip":
        path = path.with_suffix(".zip")

    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        envelope_dict = envelope.model_dump(mode="json")
        for asset in envelope_dict["assets"]:
            asset["data"] = None
            ext = _ext_from_mime(asset.get("mime"))
            asset["filename"] = f"assets/{asset['id']}{ext}"
        zf.writestr(
            "bundle.json",
            json.dumps(envelope_dict, ensure_ascii=False, indent=2, sort_keys=True),
        )
        for asset in envelope.assets:
            if asset.data is None:
                continue
            ext = _ext_from_mime(asset.mime)
            filename = f"assets/{asset.id}{ext}"
            zf.writestr(filename, base64.b64decode(asset.data))

    return path


async def export_to_file(
    db: AsyncSession, scope: ExportScope, options: ExportOptions, path: str | Path
) -> dict:
    """Export a bundle and write it to disk, returning a short summary."""
    envelope = await export_bundle(db, scope, options)
    out_path = write_bundle(envelope, path)
    raw = out_path.read_bytes()
    return {
        "path": str(out_path),
        "entities": len(envelope.entities),
        "assets": len(envelope.assets),
        "bytes": len(raw),
    }

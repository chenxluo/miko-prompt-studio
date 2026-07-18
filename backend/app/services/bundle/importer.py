"""Bundle importer: read, validate, dry-run, conflict-resolve, apply."""

from __future__ import annotations

import base64
import json
import mimetypes
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy import inspect, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings

from .schema import (
    BUNDLE_FORMAT,
    BUNDLE_SCHEMA_VERSION,
    BundleEntity,
    BundleEnvelope,
)
from .serialize import REGISTRY, EntitySpec, from_bundle_entity


@dataclass
class ImportOptions:
    """Options controlling how an import is applied."""

    mode: str = "skip"
    dry_run: bool = False
    include_assets: bool = True


@dataclass
class ImportReport:
    """Summary of what an import did or would do."""

    created: list[str] = field(default_factory=list)
    updated: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    duplicated: list[str] = field(default_factory=list)
    renamed: list[tuple[str, str]] = field(default_factory=list)
    conflicts: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    redactions_needed: list[str] = field(default_factory=list)


# Cross-entity references that are not covered by fk_cols but still need
# idmap substitution in duplicate mode.
_REF_FIELDS: dict[str, list[str]] = {
    "task": ["current_version_id", "translated_from_version_id"],
    "task_version": ["parent_version_id"],
    "sample_set": ["record_ids"],
}


def _validate_manifest(envelope: BundleEnvelope) -> None:
    if envelope.manifest.format != BUNDLE_FORMAT:
        raise ValueError(
            f"Invalid bundle format: {envelope.manifest.format!r} (expected {BUNDLE_FORMAT!r})"
        )
    major = envelope.manifest.schema_version.split(".")[0]
    expected_major = BUNDLE_SCHEMA_VERSION.split(".")[0]
    if major != expected_major:
        raise ValueError(
            f"Unsupported schema major version: {envelope.manifest.schema_version} "
            f"(expected {BUNDLE_SCHEMA_VERSION})"
        )


def _generate_new_id(old_id: str) -> str:
    prefix = old_id.split("_", 1)[0]
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _make_unique_name(name: str, used: set[str]) -> str:
    candidate = f"{name} (imported)"
    i = 2
    while candidate in used:
        candidate = f"{name} (imported {i})"
        i += 1
    return candidate


def _apply_idmap(fields: dict[str, Any], spec: EntitySpec, idmap: dict[str, str]) -> dict[str, Any]:
    """Return a copy of ``fields`` with old ids replaced by their remapped ids."""
    new_fields = dict(fields)
    for fk_attr in spec.fk_cols:
        if fk_attr in new_fields and new_fields[fk_attr] in idmap:
            new_fields[fk_attr] = idmap[new_fields[fk_attr]]
    for attr in _REF_FIELDS.get(spec.kind, []):
        if attr not in new_fields:
            continue
        value = new_fields[attr]
        if attr == "record_ids" and isinstance(value, list):
            new_fields[attr] = [idmap.get(v, v) for v in value]
        elif value in idmap:
            new_fields[attr] = idmap[value]
    return new_fields


async def _resolve_sample_record_assets(
    fields: dict[str, Any], envelope: BundleEnvelope, report: ImportReport
) -> dict[str, Any]:
    """Write bundled image assets into the local uploads directory."""
    data = fields.get("data") or {}
    images = data.get("images") or []
    if not images:
        return fields

    asset_by_id = {a.id: a for a in envelope.assets}
    settings = get_settings()
    settings.uploads_dir.mkdir(parents=True, exist_ok=True)

    for img in images:
        path = img.get("path")
        if not isinstance(path, str) or not path.startswith("bundle:"):
            continue
        asset_id = path.split(":", 1)[1]
        asset = asset_by_id.get(asset_id)
        if asset is None or asset.data is None:
            report.warnings.append(f"sample_record: missing asset data for {asset_id}")
            continue
        ext = _ext_from_mime(asset.mime)
        new_path = settings.uploads_dir / f"img_{uuid.uuid4().hex[:12]}{ext}"
        new_path.write_bytes(base64.b64decode(asset.data))
        img["path"] = str(new_path)

    return fields


def _copy_orm_fields(source: Any, target: Any, spec: EntitySpec) -> None:
    """Copy bundle-carried column values from ``source`` onto the existing ``target``.

    Columns the bundle never carries a real value for — secrets (e.g.
    ``api_key_encrypted``) and ``null_on_export`` fields (e.g. ``base_url``,
    ``models_cached_at``) — are skipped so that overwrite mode never clobbers a
    locally-configured secret or endpoint with the redacted None.
    """
    protected = set(spec.secret_cols) | set(spec.null_on_export)
    for attr in inspect(source).attrs:
        key = attr.key
        if key == "id" or key in protected:
            continue
        setattr(target, key, getattr(source, key))


def _ext_from_mime(mime: str | None) -> str:
    if mime:
        ext = mimetypes.guess_extension(mime)
        if ext:
            return ext
    return ".bin"


def read_bundle(path: str | Path) -> BundleEnvelope:
    """Read a bundle from a JSON file or a ZIP archive."""
    path = Path(path)

    if path.is_dir() or zipfile.is_zipfile(path):
        with zipfile.ZipFile(path, "r") as zf:
            with zf.open("bundle.json") as f:
                data = json.loads(f.read().decode("utf-8"))
            for asset in data.get("assets", []):
                filename = asset.get("filename")
                if filename:
                    with zf.open(filename) as f:
                        asset["data"] = base64.b64encode(f.read()).decode("ascii")
        envelope = BundleEnvelope.model_validate(data)
    else:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        envelope = BundleEnvelope.model_validate(data)

    _validate_manifest(envelope)
    return envelope


async def import_bundle(
    db: AsyncSession, envelope: BundleEnvelope, options: ImportOptions
) -> ImportReport:
    """Import a bundle into the database according to ``options``."""
    report = ImportReport()
    _validate_manifest(envelope)

    # Entity ids present in the bundle, grouped by kind.
    entity_ids_by_kind: dict[str, set[str]] = {kind: set() for kind in REGISTRY}
    for entity in envelope.entities:
        if entity.kind in entity_ids_by_kind:
            entity_ids_by_kind[entity.kind].add(entity.id)

    # Pre-compute id remapping for duplicate mode so forward references work.
    idmap: dict[str, str] = {}
    if options.mode == "duplicate":
        for entity in envelope.entities:
            idmap[entity.id] = _generate_new_id(entity.id)

    # Snapshot existing ids and unique names from the DB.
    existing_ids_by_kind: dict[str, set[str]] = {}
    existing_names_by_kind: dict[str, dict[str, str]] = {}
    for kind, ids in entity_ids_by_kind.items():
        if not ids:
            continue
        spec = REGISTRY[kind]
        existing_rows = (
            await db.execute(select(getattr(spec.orm, spec.key_col)))
        ).scalars().all()
        existing_ids_by_kind[kind] = set(existing_rows)
        if spec.name_col:
            name_rows = (
                await db.execute(
                    select(
                        getattr(spec.orm, spec.name_col),
                        getattr(spec.orm, spec.key_col),
                    )
                )
            ).all()
            existing_names_by_kind[kind] = {
                str(row[0]): str(row[1]) for row in name_rows
            }

    # Track names already consumed during this import to avoid intra-import collisions.
    used_names: dict[str, set[str]] = {
        kind: set(existing_names_by_kind.get(kind, {}).keys()) for kind in REGISTRY
    }

    stable_order = list(REGISTRY.keys())
    sorted_entities = sorted(
        envelope.entities, key=lambda e: (stable_order.index(e.kind), e.id)
    )

    for entity in sorted_entities:
        spec = REGISTRY[entity.kind]
        old_id = entity.id
        new_id = idmap.get(old_id, old_id)
        exists = old_id in existing_ids_by_kind.get(entity.kind, set())

        if options.mode == "skip" and exists:
            report.skipped.append(f"{entity.kind}:{old_id}")
            continue

        if options.mode == "duplicate":
            action = "duplicate"
            exists = False
        elif exists and options.mode == "overwrite":
            action = "update"
        else:
            action = "insert"

        fields = dict(entity.fields)
        fields[spec.key_col] = new_id

        # Name collision handling.
        if spec.name_col and spec.name_col in fields:
            desired_name: str = fields[spec.name_col]
            resolved_name: str = desired_name
            if desired_name in used_names[entity.kind]:
                existing_key = existing_names_by_kind.get(entity.kind, {}).get(
                    desired_name
                )
                if existing_key != old_id or options.mode == "duplicate":
                    resolved_name = _make_unique_name(desired_name, used_names[entity.kind])
                    report.renamed.append((f"{entity.kind}:{new_id}", resolved_name))
            used_names[entity.kind].add(resolved_name)
            fields[spec.name_col] = resolved_name

        # Apply id remapping to cross-entity references.
        fields = _apply_idmap(fields, spec, idmap)

        # Materialize bundled image assets into the local filesystem.
        if entity.kind == "sample_record" and options.include_assets:
            fields = await _resolve_sample_record_assets(fields, envelope, report)

        # Construct the ORM row from the prepared fields.
        import_entity = BundleEntity(
            kind=entity.kind,
            payload_version=entity.payload_version,
            id=new_id,
            fields=fields,
        )
        obj = from_bundle_entity(import_entity, spec)

        if options.dry_run:
            if action == "insert":
                report.created.append(f"{entity.kind}:{new_id}")
            elif action == "update":
                report.updated.append(f"{entity.kind}:{old_id}")
            elif action == "duplicate":
                report.duplicated.append(f"{entity.kind}:{old_id} -> {new_id}")
            continue

        if action == "insert" or action == "duplicate":
            db.add(obj)
            if action == "duplicate":
                report.duplicated.append(f"{entity.kind}:{old_id} -> {new_id}")
            else:
                report.created.append(f"{entity.kind}:{new_id}")
        elif action == "update":
            existing = (
                await db.execute(
                    select(spec.orm).where(
                        getattr(spec.orm, spec.key_col) == old_id
                    )
                )
            ).scalar_one()
            _copy_orm_fields(obj, existing, spec)
            report.updated.append(f"{entity.kind}:{old_id}")

        # Record required user reconfiguration for imported provider configs.
        if entity.kind == "provider_config":
            report.redactions_needed.append(f"provider_config:{new_id}:api_key")
            report.redactions_needed.append(f"provider_config:{new_id}:base_url")

    if options.dry_run:
        report.warnings.append("dry run: no changes applied")
    else:
        await db.flush()

    return report


async def import_from_file(
    db: AsyncSession, path: str | Path, options: ImportOptions | None = None
) -> ImportReport:
    """Convenience helper that reads a bundle from disk and imports it."""
    if options is None:
        options = ImportOptions()
    envelope = read_bundle(path)
    return await import_bundle(db, envelope, options)

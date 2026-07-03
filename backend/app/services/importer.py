"""CSV / TSV importer – converts tabular data into Sample Records.

Mirrors section 10.2 of 设计文档.md and section 1.5 of 文件格式文档.md.

CSV is the simplest import path.  The user provides a column mapping that
maps CSV columns to sample fields (sample_id, image roles, vars, metadata).
"""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from app.schemas.prompt import ImageSlotSpec, VariableSpec
from app.schemas.sample_record import ImageRef, SampleRecord


class ColumnMapping(BaseModel):
    """Declarative mapping from CSV columns to Sample Record fields."""

    id_column: str = "id"
    sample_type: str = "single_image"

    # Each entry maps a CSV column to an image role.
    image_columns: list[dict[str, str]] = Field(
        default_factory=list
    )  # [{"column": "target_image", "role": "target"}]

    # Columns that become template variables.
    var_columns: list[str] = Field(default_factory=list)

    # Columns that become metadata.
    metadata_columns: list[str] = Field(default_factory=list)

    # Default path prefix for relative image paths.
    base_dir: str | None = None

    # Optional reference TaskVersion for contract-aware validation/suggestions.
    task_version_id: str | None = None


def _is_uri(value: str) -> bool:
    return value.startswith(("http://", "https://", "data:"))


def _resolve_path(base_dir: str | None, path: str) -> str:
    """Resolve a potentially relative image path."""
    if not base_dir:
        return path
    return str(Path(base_dir) / path)


def _image_ref_from_value(
    value: str, role: str, order: int, base_dir: str | None = None
) -> ImageRef:
    """Create an ImageRef, preserving URL-like values as uri and resolving local paths."""
    value = value.strip()
    if _is_uri(value):
        display_name = None
        if not value.startswith("data:"):
            display_name = Path(value.split("?", 1)[0].rstrip("/")).name or None
        return ImageRef(role=role, uri=value, path=None, display_name=display_name, order=order)

    return ImageRef(
        role=role,
        path=_resolve_path(base_dir, value),
        uri=None,
        display_name=Path(value).name,
        order=order,
    )


def import_csv(
    csv_path: str | Path,
    mapping: ColumnMapping,
    delimiter: str = ",",
) -> list[SampleRecord]:
    """Import a CSV/TSV file and return a list of Sample Records.

    Args:
        csv_path: Path to the CSV file.
        mapping: Column mapping configuration.
        delimiter: Field delimiter (`,` for CSV, `\\t` for TSV).

    Returns:
        List of :class:`SampleRecord` objects.
    """
    csv_path = Path(csv_path)

    with csv_path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f, delimiter=delimiter)
        if reader.fieldnames is None:
            return []

        records: list[SampleRecord] = []

        for row in reader:
            sample_id = row.get(mapping.id_column, "")
            if not sample_id:
                continue

            # Build images
            images: list[ImageRef] = []
            for img_col in mapping.image_columns:
                col_name = img_col["column"]
                role = img_col.get("role", "target")
                img_path = row.get(col_name, "")
                if not img_path:
                    continue
                images.append(_image_ref_from_value(img_path, role, len(images), mapping.base_dir))

            # Build vars
            vars_: dict[str, Any] = {}
            for col in mapping.var_columns:
                val = row.get(col)
                if val is not None and val != "":
                    vars_[col] = val

            # Build metadata
            metadata: dict[str, Any] = {}
            for col in mapping.metadata_columns:
                val = row.get(col)
                if val is not None and val != "":
                    metadata[col] = val

            records.append(
                SampleRecord(
                    sample_id=sample_id,
                    sample_type=mapping.sample_type,
                    images=images,
                    vars=vars_,
                    metadata=metadata,
                )
            )

        return records


def suggest_column_mapping(
    columns: list[str],
    image_slot_specs: list[ImageSlotSpec] | None = None,
    variable_specs: list[VariableSpec] | None = None,
) -> ColumnMapping:
    """Suggest a loose import mapping from column names and an optional prompt contract."""
    id_column = next(
        (col for col in columns if col.lower() in {"id", "sample_id", "image_id"}), "id"
    )
    used = {id_column} if id_column in columns else set()

    image_columns: list[dict[str, str]] = []
    if image_slot_specs is not None:
        for slot in image_slot_specs:
            role = slot.role_hint or slot.slot_id
            if not role:
                continue
            for candidate in (f"image_{role}", role):
                if candidate in columns and candidate not in used:
                    image_columns.append({"column": candidate, "role": role})
                    used.add(candidate)
                    break
    else:
        for col in columns:
            if col.startswith("image_") and col not in used:
                role = col.removeprefix("image_") or "target"
                image_columns.append({"column": col, "role": role})
                used.add(col)

    var_columns: list[str] = []
    if variable_specs is not None:
        for spec in variable_specs:
            if not spec.var_id:
                continue
            for candidate in (f"var_{spec.var_id}", spec.var_id):
                if candidate in columns and candidate not in used:
                    var_columns.append(candidate)
                    used.add(candidate)
                    break

    metadata_columns = [col for col in columns if col not in used]
    return ColumnMapping(
        id_column=id_column,
        image_columns=image_columns,
        var_columns=var_columns,
        metadata_columns=metadata_columns,
    )


def import_jsonl(jsonl_path: str | Path) -> list[SampleRecord]:
    """Import a JSONL file and return validated Sample Records."""

    jsonl_path = Path(jsonl_path)
    records: list[SampleRecord] = []

    with jsonl_path.open("r", encoding="utf-8") as f:
        for line_number, line in enumerate(f, start=1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                data = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise ValueError(f"Invalid JSON on line {line_number}: {exc.msg}") from exc
            if not isinstance(data, dict):
                raise ValueError(f"Line {line_number} must be a JSON object")
            if not data.get("sample_id"):
                from uuid import uuid4

                data["sample_id"] = f"sr_{uuid4().hex[:12]}"
            try:
                records.append(SampleRecord.model_validate(data))
            except Exception as exc:
                raise ValueError(f"Invalid SampleRecord on line {line_number}: {exc}") from exc

    return records


def detect_columns(csv_path: str | Path, delimiter: str = ",") -> list[str]:
    """Return the column names from the first row of a CSV file."""
    csv_path = Path(csv_path)
    with csv_path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.reader(f, delimiter=delimiter)
        try:
            return next(reader)
        except StopIteration:
            return []


def preview_csv(
    csv_path: str | Path,
    n_rows: int = 5,
    delimiter: str = ",",
) -> tuple[list[str], list[dict[str, str]]]:
    """Preview the first n rows of a CSV file.

    Returns:
        Tuple of (column_names, rows).
    """
    csv_path = Path(csv_path)
    with csv_path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f, delimiter=delimiter)
        columns = reader.fieldnames or []
        rows = []
        for i, row in enumerate(reader):
            if i >= n_rows:
                break
            rows.append(dict(row))
        return columns, rows

"""CSV / TSV importer – converts tabular data into Sample Records.

Mirrors section 10.2 of 设计文档.md and section 1.5 of 文件格式文档.md.

CSV is the simplest import path.  The user provides a column mapping that
maps CSV columns to sample fields (sample_id, image roles, vars, metadata).
"""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

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


def _resolve_path(base_dir: str | None, path: str) -> str:
    """Resolve a potentially relative image path."""
    if not base_dir:
        return path
    return str(Path(base_dir) / path)


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
                resolved = _resolve_path(mapping.base_dir, img_path)
                images.append(
                    ImageRef(
                        role=role,
                        path=resolved,
                        display_name=Path(img_path).name,
                        order=len(images),
                    )
                )

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

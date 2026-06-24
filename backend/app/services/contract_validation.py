"""Validation helpers for SampleRecord ↔ PromptVersion contracts."""

from __future__ import annotations

from pydantic import BaseModel, Field

from app.schemas.prompt import ImageSlotSpec, VariableSpec
from app.schemas.sample_record import SampleRecord


class InvalidRow(BaseModel):
    row_index: int
    sample_id: str | None = None
    errors: list[str] = Field(default_factory=list)


def _is_non_empty(value: object) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return value.strip() != ""
    return True


def validate_sample_against_specs(
    sample: SampleRecord,
    image_slot_specs: list[ImageSlotSpec],
    variable_specs: list[VariableSpec],
) -> list[str]:
    """Return human-readable contract validation errors for a sample."""
    errors: list[str] = []

    for slot in image_slot_specs:
        if not slot.required:
            continue
        role = slot.role_hint or slot.slot_id
        if not role:
            continue
        count = sum(1 for image in sample.images if image.role == role)
        if count < slot.min_count:
            errors.append(
                f"Required image slot '{role}' needs at least {slot.min_count} image(s), found {count}."
            )

    for spec in variable_specs:
        if not spec.required or not spec.var_id:
            continue
        if spec.var_id not in sample.vars or not _is_non_empty(sample.vars.get(spec.var_id)):
            errors.append(f"Required variable '{spec.var_id}' is missing or empty.")

    return errors


def validate_records_against_contract(
    records: list[SampleRecord],
    image_slot_specs: list[ImageSlotSpec],
    variable_specs: list[VariableSpec],
) -> tuple[list[SampleRecord], list[InvalidRow]]:
    valid_records: list[SampleRecord] = []
    invalid_rows: list[InvalidRow] = []

    for index, record in enumerate(records, start=1):
        errors = validate_sample_against_specs(record, image_slot_specs, variable_specs)
        if errors:
            invalid_rows.append(
                InvalidRow(row_index=index, sample_id=record.sample_id, errors=errors)
            )
        else:
            valid_records.append(record)

    return valid_records, invalid_rows

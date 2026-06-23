"""Generate import/input specifications for task versions."""

from __future__ import annotations

from typing import Any

from app.models.prompt import PromptVersionORM
from app.models.task import TaskORM, TaskVersionORM
from app.schemas.prompt import ImageSlotSpec, VariableSpec
from app.schemas.task import (
    TaskInputExpectedColumn,
    TaskInputImageSlot,
    TaskInputPromptSummary,
    TaskInputSpec,
    TaskInputVariableSlot,
)


def _image_role(slot: ImageSlotSpec) -> str:
    return slot.role_hint or slot.slot_id


def _image_example_value(role: str, slot: ImageSlotSpec) -> str:
    if slot.max_count is None or slot.max_count > 1 or slot.min_count > 1:
        count = max(slot.min_count, 2)
        return ";".join(f"path/to/{role}_{index}.jpg" for index in range(1, count + 1))
    return f"path/to/{role}.jpg"


def _variable_example_value(spec: VariableSpec) -> str:
    if spec.default_value != "":
        return str(spec.default_value)
    return f"example_{spec.var_id}"


def generate_input_spec_for_task_version(
    task: TaskORM,
    task_version: TaskVersionORM,
    prompt_version: PromptVersionORM,
) -> TaskInputSpec:
    image_specs = [ImageSlotSpec(**item) for item in (prompt_version.image_slot_specs or [])]
    variable_specs = [VariableSpec(**item) for item in (prompt_version.variable_specs or [])]

    image_slots: list[TaskInputImageSlot] = []
    variable_slots: list[TaskInputVariableSlot] = []
    expected_columns: list[TaskInputExpectedColumn] = []
    csv_example_row: dict[str, str] = {"sample_id": "sample_001"}
    json_images: list[dict[str, Any]] = []
    json_vars: dict[str, Any] = {}

    for slot in image_specs:
        image_slots.append(
            TaskInputImageSlot(
                slot_id=slot.slot_id,
                role_hint=slot.role_hint,
                label=slot.label,
                required=slot.required,
                min_count=slot.min_count,
                max_count=slot.max_count,
                description=slot.description,
            )
        )
        role = _image_role(slot)
        if not role:
            continue
        column = f"image_{role}"
        expected_columns.append(
            TaskInputExpectedColumn(
                column=column,
                kind="image",
                role_hint=role,
                required=slot.required,
            )
        )
        csv_example_row[column] = _image_example_value(role, slot)
        json_images.append(
            {
                "role": role,
                "path": f"path/to/{role}.jpg",
            }
        )

    for spec in variable_specs:
        variable_slots.append(
            TaskInputVariableSlot(
                var_id=spec.var_id,
                label=spec.label,
                description=spec.description,
                required=spec.required,
                default_value=spec.default_value,
                type=spec.type,
            )
        )
        if not spec.var_id:
            continue
        column = f"var_{spec.var_id}"
        expected_columns.append(
            TaskInputExpectedColumn(
                column=column,
                kind="variable",
                var_id=spec.var_id,
                required=spec.required,
            )
        )
        example_value = _variable_example_value(spec)
        csv_example_row[column] = example_value
        json_vars[spec.var_id] = example_value

    return TaskInputSpec(
        task_id=task.task_id,
        task_version_id=task_version.task_version_id,
        task_name=task.name,
        version_label=task_version.version_label,
        system_prompt=prompt_version.system_prompt,
        user_template=prompt_version.user_template,
        format_instruction=prompt_version.format_instruction,
        image_slots=image_slots,
        variable_slots=variable_slots,
        expected_csv_columns=expected_columns,
        csv_example_row=csv_example_row,
        jsonl_example={
            "sample_id": "sample_001",
            "images": json_images,
            "vars": json_vars,
        },
        notes=(
            "CSV imports should include sample_id plus the expected columns. "
            "Image columns use image_<role_hint>; variable columns use var_<var_id> "
            "(plain <var_id> is also accepted by smart column mapping)."
        ),
    )

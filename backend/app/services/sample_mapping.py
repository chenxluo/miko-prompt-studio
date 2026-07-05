"""Runtime sample-to-task field mapping helpers."""

from __future__ import annotations

from typing import Any

from app.schemas.sample_record import SampleRecord


def apply_sample_mapping(
    sample: SampleRecord,
    variable_mapping: dict[str, str] | None = None,
    image_role_mapping: dict[str, str] | None = None,
) -> SampleRecord:
    """Return a mapped copy of ``sample`` for the target task version.

    ``variable_mapping`` maps ``task_var_id -> sample.vars key``.
    ``image_role_mapping`` maps ``task_role_hint -> sample.images[].role``.
    """
    variable_mapping = variable_mapping or {}
    image_role_mapping = image_role_mapping or {}

    if not variable_mapping and not image_role_mapping:
        return sample

    mapped_vars: dict[str, Any]
    if variable_mapping:
        mapped_vars = {}
        for task_var_id, sample_key in variable_mapping.items():
            if sample_key in sample.vars:
                mapped_vars[task_var_id] = sample.vars[sample_key]
        # Carry over unmapped vars so templates that reference sample keys directly still work.
        for key, value in sample.vars.items():
            if key not in mapped_vars:
                mapped_vars[key] = value
    else:
        mapped_vars = sample.vars.copy()

    mapped_images: list
    if image_role_mapping:
        role_to_task_role = {
            sample_role: task_role for task_role, sample_role in image_role_mapping.items()
        }
        mapped_images = []
        for image in sample.images:
            task_role = role_to_task_role.get(image.role)
            if task_role is not None:
                mapped_images.append(image.model_copy(update={"role": task_role}, deep=True))
            else:
                mapped_images.append(image.model_copy(deep=True))
    else:
        mapped_images = [image.model_copy(deep=True) for image in sample.images]

    return sample.model_copy(
        update={"vars": mapped_vars, "images": mapped_images},
        deep=True,
    )

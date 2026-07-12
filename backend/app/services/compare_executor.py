"""Thin adapter for Compare Mode runs using the shared matrix executor."""

from __future__ import annotations

from dataclasses import dataclass, field

from app.schemas.common import RunType
from app.schemas.run_record import RunSource
from app.schemas.sample_record import SampleRecord
from app.services.matrix_executor import (
    _MatrixRunSpec,
    _MatrixVariant,
    request_matrix_cancel,
    start_matrix_run,
)
from app.services.run_executor import LabRunRequest


@dataclass(frozen=True)
class VariantSpec:
    label: str
    request_template: LabRunRequest
    task_id: str
    task_version_id: str
    prompt_id: str | None = None
    prompt_version_id: str | None = None
    variable_mapping: dict[str, str] = field(default_factory=dict)
    image_role_mapping: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class CompareRunSpec:
    run_id: str
    name: str
    source: RunSource | dict
    samples: list[SampleRecord]
    variants: list[VariantSpec]
    max_concurrency: int = 1
    max_retries: int = 0


async def start_compare_run(spec: CompareRunSpec) -> str:
    variants = [
        _MatrixVariant(
            label=v.label,
            request_template=v.request_template,
            variable_mapping=v.variable_mapping,
            image_role_mapping=v.image_role_mapping,
            task_id=v.task_id,
            task_version_id=v.task_version_id,
            prompt_id=v.prompt_id,
            prompt_version_id=v.prompt_version_id,
            has_axes=True,
        )
        for v in spec.variants
    ]
    matrix_spec = _MatrixRunSpec(
        run_id=spec.run_id,
        name=spec.name,
        source=spec.source,
        samples=spec.samples,
        variants=variants,
        run_type=RunType.COMPARE.value,
        max_concurrency=spec.max_concurrency,
        max_retries=spec.max_retries,
    )
    return await start_matrix_run(matrix_spec)


def request_compare_cancel(run_id: str) -> bool:
    return request_matrix_cancel(run_id)

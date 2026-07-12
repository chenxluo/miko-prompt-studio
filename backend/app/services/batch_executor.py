"""Thin adapter for Batch Test runs using the shared matrix executor."""

from __future__ import annotations

from dataclasses import dataclass, field

from app.schemas.common import RunType
from app.schemas.run_record import RunSource
from app.schemas.sample_record import SampleRecord
from app.services.matrix_executor import (  # noqa: F401
    MAX_CONCURRENCY,
    MAX_RETRIES,
    _MatrixRunSpec,
    _MatrixVariant,
    _running_tasks,
    map_sample_images_to_prompt_slots,
    request_matrix_cancel,
    start_matrix_run,
)
from app.services.run_executor import LabRunRequest


@dataclass(frozen=True)
class BatchRunSpec:
    run_id: str
    name: str
    source: RunSource | dict
    samples: list[SampleRecord]
    request_template: LabRunRequest
    max_concurrency: int = 1
    max_retries: int = 0
    variable_mapping: dict[str, str] = field(default_factory=dict)
    image_role_mapping: dict[str, str] = field(default_factory=dict)
    pipeline_id: str | None = None
    pipeline_step: str | None = None


async def start_batch_run(spec: BatchRunSpec) -> str:
    variant = _MatrixVariant(
        label="batch",
        request_template=spec.request_template,
        variable_mapping=spec.variable_mapping,
        image_role_mapping=spec.image_role_mapping,
        has_axes=False,
    )
    matrix_spec = _MatrixRunSpec(
        run_id=spec.run_id,
        name=spec.name,
        source=spec.source,
        samples=spec.samples,
        variants=[variant],
        run_type=RunType.BATCH.value,
        max_concurrency=spec.max_concurrency,
        max_retries=spec.max_retries,
        pipeline_id=spec.pipeline_id,
        pipeline_step=spec.pipeline_step,
    )
    return await start_matrix_run(matrix_spec)


def request_cancel(run_id: str) -> bool:
    return request_matrix_cancel(run_id)

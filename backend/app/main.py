"""FastAPI application entry point.

Run with:  uvicorn app.main:app --reload
"""

from __future__ import annotations

import asyncio
import csv
import hashlib
import io
import json
import shutil
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4
from urllib.parse import quote

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.config import get_settings
from app.core.security import (
    delete_api_key,
    get_api_key,
    list_api_key_providers,
    mask_api_key,
    store_api_key,
)
from app.database import get_db, init_db
from app.models.model_config import ModelConfigORM
from app.models.pricing import PricingProfileORM
from app.models.prompt import PromptORM
from app.models.result_snapshot import ResultSnapshotORM
from app.models.run import AttemptORM, RunItemORM, RunSessionORM
from app.models.sample import SampleRecordORM, SampleSetORM
from app.models.task import TaskGroupORM, TaskORM, TaskVersionORM
from app.schemas.common import RunItemType, RunSessionStatus, RunType, utc_now
from app.schemas.model_config import ModelConfig, ModelParameters
from app.schemas.output_contract import OutputContract, OutputMode
from app.schemas.pricing import PricingProfile, PricingSnapshot
from app.schemas.prompt import (
    ImageSlotSpec,
    PromptVersionData,
    VariableSpec,
)
from app.schemas.result_snapshot import ResultSnapshot as ResultSnapshotSchema
from app.schemas.run_record import ConfigSnapshot, RunSource, StreamEvent, Usage
from app.schemas.sample_record import SampleRecord
from app.schemas.task import (
    Task,
    TaskGroup,
    TaskInputSpec,
    TaskVersion,
    TaskVersionData as TaskVersionDataSchema,
    TaskVersionSummary,
)
from app.services.cost_engine import calculate_cost
from app.services.image_persist import (
    persist_request_images,
    rewrite_image_uris,
)
from app.services.contract_validation import (
    InvalidRow,
    validate_records_against_contract,
)
from app.services.input_spec_generator import generate_input_spec_for_task_version
from app.services.task_doc_generator import generate_task_doc
from app.services.html_export import render_run_html
from app.services.importer import (
    ColumnMapping,
    detect_columns,
    import_csv,
    import_jsonl,
    preview_csv,
    suggest_column_mapping,
)
from app.services.run_executor import LabRunRequest, execute_lab_run
from app.services.batch_executor import (
    MAX_CONCURRENCY,
    MAX_RETRIES,
    BatchRunSpec,
    request_cancel,
    start_batch_run,
)
from app.services.compare_executor import (
    CompareRunSpec,
    VariantSpec,
    request_compare_cancel,
    start_compare_run,
)
from app.services.request_builder import _pricing_snapshot


# ---------------------------------------------------------------------------
# App lifecycle
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(
    title="Miko Prompt Studio",
    description="Image annotation lab backend",
    version="0.1.0",
    lifespan=lifespan,
)

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Request / response DTOs
# ---------------------------------------------------------------------------


class LabRunPayload(BaseModel):
    """Payload for POST /api/lab/run."""

    sample: SampleRecord
    system_prompt: str = ""
    user_prompt: str = ""
    prompt_version_id: str | None = None
    prompt_id: str | None = None

    # Provider config — the preferred way to specify adapter + base_url + api_key.
    # If provided, adapter_id / api_base_url below are ignored (taken from the config).
    provider_config_id: str | None = None

    # Legacy / ad-hoc fields (used when provider_config_id is None)
    model_config_id: str | None = None
    provider_id: str = ""
    model_id: str
    adapter_id: str = "openai"
    parameters: ModelParameters = Field(default_factory=ModelParameters)
    provider_options: dict[str, Any] = Field(default_factory=dict)
    api_base_url: str | None = None

    output_contract: OutputContract = Field(default_factory=OutputContract)
    image_slot_specs: list[ImageSlotSpec] = Field(default_factory=list)
    variable_specs: list[VariableSpec] = Field(default_factory=list)
    pricing_profile_id: str | None = None
    image_resolution_enabled: bool = False
    image_resolution_target: int = 1024
    run_name: str = ""


class BatchRunPayload(BaseModel):
    """Payload for POST /api/batch-runs."""

    task_id: str
    sample_set_id: str
    task_version_id: str | None = None
    limit: int | None = None
    max_concurrency: int = 1
    max_retries: int = 0


class CompareTaskVersion(BaseModel):
    task_id: str
    task_version_id: str | None = None


class CompareVariant(CompareTaskVersion):
    label: str | None = None


class CompareRunPayload(BaseModel):
    """Payload for POST /api/compare-runs."""

    sample_set_id: str
    variants: list[CompareVariant] = Field(min_length=1)
    limit: int | None = None
    name: str = ""


class CreateModelConfigPayload(BaseModel):
    name: str
    provider_id: str
    model_id: str
    adapter_id: str = "openai"
    parameters: ModelParameters = Field(default_factory=ModelParameters)
    provider_options: dict[str, Any] = Field(default_factory=dict)
    notes: str = ""


class CreatePricingPayload(BaseModel):
    provider_id: str | None = None
    provider_config_id: str | None = None
    model_id: str
    currency: str = "USD"
    input_token_price: float = 0.0
    output_token_price: float = 0.0
    cached_input_price: float | None = None
    batch_discount: float = 1.0
    image_pricing: dict[str, Any] = Field(default_factory=dict)
    notes: str = ""


class SavePromptPayload(BaseModel):
    name: str
    system_prompt: str = ""
    user_template: str = ""
    notes: str = ""
    prompt_id: str | None = None  # if provided, overwrites the existing snippet


class UpdateReviewPayload(BaseModel):
    accepted: bool | None = None
    rating: int | None = None
    notes: str = ""


class CreateResultSnapshotPayload(BaseModel):
    run_id: str
    run_item_id: str | None = None
    attempt_id: str | None = None
    name: str
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    notes: str = ""
    starred: bool = False
    linked_task_version_id: str | None = None


class UpdateResultSnapshotPayload(BaseModel):
    name: str | None = None
    description: str | None = None
    tags: list[str] | None = None
    notes: str | None = None
    starred: bool | None = None
    accepted: bool | None = None
    rating: int | None = None
    linked_task_version_id: str | None = None


class ApiKeyPayload(BaseModel):
    api_key: str


class CsvImportPayload(BaseModel):
    csv_path: str
    mapping: ColumnMapping
    delimiter: str = ","
    sample_set_name: str = ""
    task_version_id: str | None = None
    validate_only: bool = False


class ImportValidationReport(BaseModel):
    valid_count: int
    invalid_rows: list[InvalidRow] = Field(default_factory=list)


class CreateTaskPayload(BaseModel):
    name: str
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    group_id: str | None = None
    version: TaskVersionDataSchema


class CreateTaskVersionPayload(TaskVersionDataSchema):
    """Flat payload for creating a task version (no wrapping)."""


class UpdateTaskPayload(BaseModel):
    name: str | None = None
    description: str | None = None
    tags: list[str] | None = None
    current_version_id: str | None = None
    group_id: str | None = None


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "0.1.0"}


# ---------------------------------------------------------------------------
# Providers & model discovery
# ---------------------------------------------------------------------------


@app.get("/api/providers")
async def list_providers():
    """Return metadata for all registered provider adapters."""

    from app.adapters.registry import list_adapter_metadata

    return {"providers": list_adapter_metadata()}


class FetchModelsPayload(BaseModel):
    provider_config_id: str | None = None
    adapter_id: str = "openai"
    api_key: str | None = None
    base_url: str | None = None


@app.post("/api/providers/models")
async def fetch_provider_models(payload: FetchModelsPayload, db: AsyncSession = Depends(get_db)):
    """Fetch the live model list from a provider's ``/v1/models`` endpoint.

    Resolution order:
    1. If ``provider_config_id`` is supplied, load the stored ``ProviderConfig``
       and use its ``adapter_id``, ``base_url`` and decrypted ``api_key``.
    2. Explicit overrides on the payload (``adapter_id``, ``api_key``,
       ``base_url``) take precedence over the stored config.
    3. If no key is resolved yet, fall back to the legacy
       ``get_api_key(db, adapter_id)`` lookup.
    """

    from app.adapters.registry import get_adapter, get_adapter_metadata
    from app.core.security import decrypt_value as _decrypt
    from app.models.provider_config import ProviderConfigORM

    pc_orm: ProviderConfigORM | None = None
    adapter_id = payload.adapter_id
    base_url = payload.base_url
    api_key = payload.api_key

    if payload.provider_config_id:
        pc_stmt = select(ProviderConfigORM).where(
            ProviderConfigORM.provider_config_id == payload.provider_config_id
        )
        pc_result = await db.execute(pc_stmt)
        pc_orm = pc_result.scalar_one_or_none()
        if pc_orm is None:
            raise HTTPException(
                404,
                f"ProviderConfig '{payload.provider_config_id}' not found.",
            )
        # Stored config provides defaults; explicit payload fields override them.
        if not adapter_id or adapter_id == "openai":
            adapter_id = pc_orm.adapter_id or adapter_id
        if not base_url:
            base_url = pc_orm.base_url
        if not api_key and pc_orm.api_key_encrypted:
            api_key = _decrypt(pc_orm.api_key_encrypted)

    adapter = get_adapter(adapter_id)
    meta = get_adapter_metadata(adapter_id) or {}
    requires_base_url = bool(meta.get("requires_base_url", False))

    if not api_key:
        # Fall back to stored key — use adapter_id as provider identifier
        api_key = await get_api_key(db, adapter_id) or ""

    if requires_base_url and not base_url:
        raise HTTPException(
            400,
            f"Adapter '{adapter_id}' requires a base_url to fetch models.",
        )

    try:
        models = await adapter.fetch_models(api_key=api_key, base_url=base_url)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, f"Provider model discovery failed: {exc}") from exc

    if pc_orm is not None:
        pc_orm.cached_models = models
        pc_orm.models_cached_at = datetime.utcnow()
        await db.commit()

    return {"models": models, "adapter_id": adapter_id}


# ---------------------------------------------------------------------------
# Lab run
# ---------------------------------------------------------------------------


@app.post("/api/lab/run")
async def lab_run(payload: LabRunPayload, db: AsyncSession = Depends(get_db)):
    """Execute a single Lab run."""

    from app.adapters.registry import get_adapter_metadata
    from app.core.security import decrypt_value
    from app.models.provider_config import ProviderConfigORM

    # Resolve provider config → adapter_id, base_url, api_key
    api_base_url = payload.api_base_url
    adapter_id = payload.adapter_id
    provider_id = payload.provider_id

    if payload.provider_config_id:
        stmt = select(ProviderConfigORM).where(
            ProviderConfigORM.provider_config_id == payload.provider_config_id
        )
        result = await db.execute(stmt)
        pc = result.scalar_one_or_none()
        if pc is None:
            raise HTTPException(404, f"Provider config '{payload.provider_config_id}' not found.")
        adapter_id = pc.adapter_id
        api_base_url = pc.base_url
        provider_id = pc.name
        # api_key is fetched inside run_executor via get_api_key,
        # but that uses provider_id as the key. We store it under the
        # provider_config_id so run_executor can find it.
    elif not provider_id:
        raise HTTPException(400, "Either provider_config_id or provider_id must be provided.")

    # Validate base_url requirement for the chosen adapter
    meta = get_adapter_metadata(adapter_id)
    if meta and meta.get("requires_base_url") and not api_base_url:
        raise HTTPException(
            400,
            f"Adapter '{adapter_id}' requires api_base_url.",
        )

    # Load or create ModelConfig
    model_config = ModelConfig(
        model_config_id=payload.model_config_id or f"mc_{uuid4().hex[:12]}",
        name=payload.model_config_id or "ad-hoc",
        provider_id=provider_id,
        model_id=payload.model_id,
        adapter_id=adapter_id,
        parameters=payload.parameters,
        provider_options=payload.provider_options,
    )

    # Build prompt version data
    prompt_data = PromptVersionData(
        system_prompt=payload.system_prompt,
        user_template=payload.user_prompt,
    )

    # Load or create pricing snapshot
    pricing = await _get_pricing(
        db,
        provider_id,
        payload.model_id,
        payload.pricing_profile_id,
        payload.provider_config_id,
    )

    run_request = LabRunRequest(
        sample=payload.sample,
        prompt=prompt_data,
        model_config=model_config,
        output_contract=payload.output_contract,
        pricing=pricing,
        api_base_url=api_base_url,
        run_name=payload.run_name,
        provider_config_id=payload.provider_config_id,
        image_resolution_enabled=payload.image_resolution_enabled,
        image_resolution_target=payload.image_resolution_target,
        image_slot_specs=payload.image_slot_specs,
        variable_specs=payload.variable_specs,
    )

    if payload.parameters.stream is True:
        return StreamingResponse(
            _stream_lab_run(db, run_request),
            media_type="text/event-stream",
        )

    session = await execute_lab_run(db, run_request)
    await db.commit()
    return session.model_dump(mode="json")


async def _stream_lab_run(db: AsyncSession, run_request: LabRunRequest):
    queue: asyncio.Queue[StreamEvent | None] = asyncio.Queue()

    async def on_event(event: StreamEvent) -> None:
        await queue.put(event)

    async def run_worker() -> None:
        try:
            session = await execute_lab_run(db, run_request, stream_callback=on_event)
            await db.commit()
            await queue.put(StreamEvent(event="done", usage={"run_id": session.run_id}))
        except Exception as exc:
            await db.rollback()
            await queue.put(
                StreamEvent(
                    event="error",
                    error={"message": str(exc), "type": "unknown_error"},
                )
            )
        finally:
            await queue.put(None)

    task = asyncio.create_task(run_worker())
    try:
        while True:
            event = await queue.get()
            if event is None:
                break
            data = event.model_dump(mode="json", exclude_none=True)
            yield f"data: {json.dumps(data, ensure_ascii=False)}\n\n"
    finally:
        if not task.done():
            task.cancel()


# ---------------------------------------------------------------------------
# Batch runs
# ---------------------------------------------------------------------------


async def _resolve_task_version_for_payload(
    payload: BatchRunPayload,
    db: AsyncSession,
) -> tuple[TaskORM, TaskVersion]:
    task = await _get_task_or_404(payload.task_id, db)
    version_id = payload.task_version_id or task.current_version_id
    if not version_id:
        raise HTTPException(400, f"Task '{payload.task_id}' has no current version.")
    version_row = await _get_task_version_or_404(payload.task_id, version_id, db)
    return task, _task_version_to_schema(version_row)


async def _resolve_batch_template(payload: BatchRunPayload, db: AsyncSession) -> LabRunRequest:
    from app.adapters.registry import get_adapter_metadata
    from app.models.provider_config import ProviderConfigORM

    task, task_version = await _resolve_task_version_for_payload(payload, db)

    pc_result = await db.execute(
        select(ProviderConfigORM).where(
            ProviderConfigORM.provider_config_id == task_version.provider_config_id
        )
    )
    pc = pc_result.scalar_one_or_none()
    if pc is None:
        raise HTTPException(
            404,
            f"Provider config '{task_version.provider_config_id}' not found.",
        )
    adapter_id = pc.adapter_id
    api_base_url = pc.base_url
    provider_id = pc.name

    meta = get_adapter_metadata(adapter_id)
    if meta and meta.get("requires_base_url") and not api_base_url:
        raise HTTPException(400, f"Adapter '{adapter_id}' requires api_base_url.")

    parameters = task_version.model_parameters.model_copy(update={"stream": False})
    model_config = ModelConfig(
        model_config_id=f"mc_{task_version.task_version_id}",
        name=f"{task.name} {task_version.version_label}",
        provider_id=provider_id,
        model_id=task_version.model_id,
        adapter_id=adapter_id,
        parameters=parameters,
        provider_options={},
    )
    prompt_data = PromptVersionData(
        system_prompt=task_version.system_prompt,
        user_template=task_version.user_template,
    )
    pricing = await _get_pricing(
        db,
        provider_id,
        task_version.model_id,
        task_version.pricing_profile_id,
        task_version.provider_config_id,
    )
    image_config = task_version.image_preprocess_config or {}
    return LabRunRequest(
        sample=SampleRecord(sample_id="batch_template"),
        prompt=prompt_data,
        model_config=model_config,
        output_contract=task_version.output_contract,
        pricing=pricing,
        api_base_url=api_base_url,
        run_name=f"Batch: {task.name}",
        provider_config_id=task_version.provider_config_id,
        image_resolution_enabled=bool(image_config.get("enabled", False)),
        image_resolution_target=int(image_config.get("target", 1024)),
        image_slot_specs=task_version.image_slot_specs,
        variable_specs=task_version.variable_specs,
    )


async def _load_batch_samples(
    payload: BatchRunPayload,
    db: AsyncSession,
    sample_ids: list[str] | None = None,
) -> list[SampleRecord]:
    set_result = await db.execute(
        select(SampleSetORM).where(SampleSetORM.sample_set_id == payload.sample_set_id)
    )
    sample_set = set_result.scalar_one_or_none()
    if sample_set is None:
        raise HTTPException(404, f"Sample set '{payload.sample_set_id}' not found.")

    stmt = select(SampleRecordORM).where(SampleRecordORM.sample_set_id == payload.sample_set_id)
    result = await db.execute(stmt)
    rows = result.scalars().all()
    rows_by_id = {row.sample_id: row for row in rows}
    ordered_ids = sample_ids or sample_set.record_ids or [row.sample_id for row in rows]
    if sample_ids:
        missing = [sample_id for sample_id in sample_ids if sample_id not in rows_by_id]
        if missing:
            raise HTTPException(404, f"Samples not found in set: {', '.join(missing)}")
    if payload.limit is not None:
        ordered_ids = ordered_ids[: max(0, payload.limit)]
    samples = [
        SampleRecord.model_validate(rows_by_id[sample_id].data)
        for sample_id in ordered_ids
        if sample_id in rows_by_id
    ]
    for sample in samples:
        sample.sample_set_id = payload.sample_set_id
    return samples


@app.post("/api/batch-runs")
async def create_batch_run(payload: BatchRunPayload, db: AsyncSession = Depends(get_db)):
    samples = await _load_batch_samples(payload, db)
    template = await _resolve_batch_template(payload, db)
    run_id = f"run_{uuid4().hex[:16]}"
    source = RunSource(
        mode="batch",
        sample_set_id=payload.sample_set_id,
        sample_ids=[sample.sample_id for sample in samples],
        provider_config_id=template.provider_config_id,
        api_base_url=template.api_base_url,
    ).model_dump(mode="json")
    source["task_id"] = payload.task_id
    source["task_version_id"] = (
        payload.task_version_id or (await _get_task_or_404(payload.task_id, db)).current_version_id
    )
    max_concurrency = max(1, min(payload.max_concurrency, MAX_CONCURRENCY))
    max_retries = max(0, min(payload.max_retries, MAX_RETRIES))
    source["max_concurrency"] = max_concurrency
    source["max_retries"] = max_retries
    spec = BatchRunSpec(
        run_id=run_id,
        name=template.run_name,
        source=source,
        samples=samples,
        request_template=template,
        max_concurrency=max_concurrency,
        max_retries=max_retries,
    )
    await start_batch_run(spec)
    return await _batch_status_response(run_id, db)


@app.get("/api/batch-runs/{run_id}/status")
async def get_batch_run_status(run_id: str, db: AsyncSession = Depends(get_db)):
    return await _batch_status_response(run_id, db)


@app.post("/api/batch-runs/{run_id}/cancel")
async def cancel_batch_run(run_id: str, db: AsyncSession = Depends(get_db)):
    session = await _get_batch_session_or_404(run_id, db)
    found = request_cancel(run_id)
    if not found and session.status == RunSessionStatus.RUNNING.value:
        session.status = RunSessionStatus.CANCELLED.value
        session.completed_at = utc_now().isoformat()
        await db.commit()
    return {"cancel_requested": True, "run_id": run_id}


@app.post("/api/batch-runs/{run_id}/retry-failed")
async def retry_failed_batch_run(run_id: str, db: AsyncSession = Depends(get_db)):
    session = await _get_batch_session_or_404(run_id, db)
    items_result = await db.execute(
        select(RunItemORM).where(
            RunItemORM.run_id == run_id,
            RunItemORM.status == RunItemType.FAILED.value,
        )
    )
    failed_sample_ids = [item.sample_id for item in items_result.scalars().all()]
    if not failed_sample_ids:
        raise HTTPException(400, "Original run has no failed items to retry.")

    source = session.source or {}
    payload = _payload_from_session_snapshot(session)
    samples = await _load_batch_samples(payload, db, failed_sample_ids)
    template = await _resolve_batch_template(payload, db)
    new_run_id = f"run_{uuid4().hex[:16]}"
    retry_source = RunSource(
        mode="batch",
        sample_set_id=source.get("sample_set_id"),
        sample_ids=failed_sample_ids,
        rerun_of=run_id,
        provider_config_id=source.get("provider_config_id"),
        api_base_url=source.get("api_base_url"),
    ).model_dump(mode="json")
    retry_source["task_id"] = payload.task_id
    retry_source["task_version_id"] = payload.task_version_id
    # Inherit the original run's concurrency/retry policy so a retry behaves
    # like the run that produced the failures.
    max_concurrency = max(1, min(int(source.get("max_concurrency") or 1), MAX_CONCURRENCY))
    max_retries = max(0, min(int(source.get("max_retries") or 0), MAX_RETRIES))
    retry_source["max_concurrency"] = max_concurrency
    retry_source["max_retries"] = max_retries
    await start_batch_run(
        BatchRunSpec(
            run_id=new_run_id,
            name=f"Retry failed: {session.name or run_id}",
            source=retry_source,
            samples=samples,
            request_template=template,
            max_concurrency=max_concurrency,
            max_retries=max_retries,
        )
    )
    return await _batch_status_response(new_run_id, db)


async def _get_batch_session_or_404(run_id: str, db: AsyncSession) -> RunSessionORM:
    result = await db.execute(
        select(RunSessionORM).where(
            RunSessionORM.run_id == run_id,
            RunSessionORM.run_type == RunType.BATCH.value,
        )
    )
    session = result.scalar_one_or_none()
    if session is None:
        raise HTTPException(404, "Batch run not found")
    return session


async def _batch_status_response(run_id: str, db: AsyncSession) -> dict[str, Any]:
    session = await _get_batch_session_or_404(run_id, db)
    items_result = await db.execute(select(RunItemORM).where(RunItemORM.run_id == run_id))
    items = items_result.scalars().all()
    return {
        "run_id": session.run_id,
        "status": session.status,
        "session": _run_session_to_dict(session),
        "summary": session.summary,
        "items": [_run_item_to_dict(item) for item in items],
    }


def _payload_from_session_snapshot(session: RunSessionORM) -> BatchRunPayload:
    source = session.source or {}
    task_id = source.get("task_id")
    if not task_id:
        raise HTTPException(400, "Original run has no task_id to retry.")
    return BatchRunPayload(
        task_id=task_id,
        sample_set_id=source.get("sample_set_id") or "",
        task_version_id=source.get("task_version_id"),
    )


# ---------------------------------------------------------------------------
# Compare runs
# ---------------------------------------------------------------------------


async def _resolve_compare_variants(
    payload: CompareRunPayload,
    db: AsyncSession,
) -> list[VariantSpec]:
    variants: list[VariantSpec] = []
    for index, variant in enumerate(payload.variants):
        batch_payload = BatchRunPayload(
            task_id=variant.task_id,
            sample_set_id=payload.sample_set_id,
            task_version_id=variant.task_version_id,
            limit=payload.limit,
        )
        task, task_version = await _resolve_task_version_for_payload(batch_payload, db)
        template = await _resolve_batch_template(batch_payload, db)
        label = (
            variant.label or f"{task.name} {task_version.version_label}" or f"Variant {index + 1}"
        )
        variants.append(
            VariantSpec(
                label=label,
                request_template=template,
                task_id=task.task_id,
                task_version_id=task_version.task_version_id,
            )
        )
    return variants


async def _load_compare_samples(
    payload: CompareRunPayload,
    db: AsyncSession,
) -> list[SampleRecord]:
    batch_payload = BatchRunPayload(
        task_id=payload.variants[0].task_id if payload.variants else "",
        sample_set_id=payload.sample_set_id,
        limit=payload.limit,
    )
    return await _load_batch_samples(batch_payload, db)


@app.post("/api/compare-runs")
async def create_compare_run(payload: CompareRunPayload, db: AsyncSession = Depends(get_db)):
    samples = await _load_compare_samples(payload, db)
    variants = await _resolve_compare_variants(payload, db)
    run_id = f"run_{uuid4().hex[:16]}"
    provider_config_ids = [variant.request_template.provider_config_id for variant in variants]
    source = RunSource(
        mode="compare",
        sample_set_id=payload.sample_set_id,
        sample_ids=[sample.sample_id for sample in samples],
        provider_config_id=provider_config_ids[0] if len(set(provider_config_ids)) == 1 else None,
        api_base_url=variants[0].request_template.api_base_url if variants else None,
    ).model_dump(mode="json")
    source["variants"] = [
        {
            "label": variant.label,
            "task_id": variant.task_id,
            "task_version_id": variant.task_version_id,
            "prompt_id": variant.prompt_id,
            "prompt_version_id": variant.prompt_version_id,
            "provider_config_id": variant.request_template.provider_config_id,
            "model_id": variant.request_template.model_config.model_id,
        }
        for variant in variants
    ]
    spec = CompareRunSpec(
        run_id=run_id,
        name=payload.name,
        source=source,
        samples=samples,
        variants=variants,
    )
    await start_compare_run(spec)
    return await _compare_status_response(run_id, db)


@app.get("/api/compare-runs/{run_id}/status")
async def get_compare_run_status(run_id: str, db: AsyncSession = Depends(get_db)):
    return await _compare_status_response(run_id, db)


@app.post("/api/compare-runs/{run_id}/cancel")
async def cancel_compare_run(run_id: str, db: AsyncSession = Depends(get_db)):
    session = await _get_compare_session_or_404(run_id, db)
    found = request_compare_cancel(run_id)
    if not found and session.status == RunSessionStatus.RUNNING.value:
        session.status = RunSessionStatus.CANCELLED.value
        session.completed_at = utc_now().isoformat()
        await db.commit()
    return {"cancel_requested": True, "run_id": run_id}


async def _get_compare_session_or_404(run_id: str, db: AsyncSession) -> RunSessionORM:
    result = await db.execute(
        select(RunSessionORM).where(
            RunSessionORM.run_id == run_id,
            RunSessionORM.run_type == RunType.COMPARE.value,
        )
    )
    session = result.scalar_one_or_none()
    if session is None:
        raise HTTPException(404, "Compare run not found")
    return session


async def _compare_status_response(run_id: str, db: AsyncSession) -> dict[str, Any]:
    session = await _get_compare_session_or_404(run_id, db)
    items_result = await db.execute(select(RunItemORM).where(RunItemORM.run_id == run_id))
    items = [_run_item_to_dict(item) for item in items_result.scalars().all()]
    matrix = _compare_matrix(items)
    return {
        "run_id": session.run_id,
        "status": session.status,
        "session": _run_session_to_dict(session),
        "summary": session.summary,
        "items": items,
        "matrix": matrix,
    }


def _compare_matrix(items: list[dict[str, Any]]) -> dict[str, Any]:
    sample_ids: list[str] = []
    variant_labels: list[str] = []
    items_by_sample: dict[str, dict[str, dict[str, Any]]] = {}
    for item in items:
        axes = item.get("compare_axes") or {}
        sample_id = axes.get("sample_id") or item.get("sample_id")
        label = axes.get("config_label") or axes.get("task_version_id") or "variant"
        if sample_id not in sample_ids:
            sample_ids.append(sample_id)
        if label not in variant_labels:
            variant_labels.append(label)
        items_by_sample.setdefault(sample_id, {})[label] = item
    return {
        "sample_ids": sample_ids,
        "variant_labels": variant_labels,
        "items_by_sample": items_by_sample,
    }


# ---------------------------------------------------------------------------
# Tasks
# ---------------------------------------------------------------------------


def _task_version_to_schema(row: TaskVersionORM) -> TaskVersion:
    return TaskVersion(
        task_version_id=row.task_version_id,
        task_id=row.task_id,
        version_label=row.version_label,
        parent_version_id=row.parent_version_id,
        system_prompt=row.system_prompt,
        user_template=row.user_template,
        provider_config_id=row.provider_config_id,
        model_id=row.model_id,
        model_parameters=ModelParameters(**(row.model_parameters or {})),
        output_contract=OutputContract(**(row.output_contract or {})),
        image_preprocess_config=row.image_preprocess_config or {},
        image_slot_specs=row.image_slot_specs or [],
        variable_specs=row.variable_specs or [],
        pricing_profile_id=row.pricing_profile_id,
        notes=row.notes,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _task_version_summary(row: TaskVersionORM | None) -> TaskVersionSummary | None:
    if row is None:
        return None
    return TaskVersionSummary(
        task_version_id=row.task_version_id,
        version_label=row.version_label,
        provider_config_id=row.provider_config_id,
        model_id=row.model_id,
        notes=row.notes,
        created_at=row.created_at,
    )


def _task_to_schema(
    row: TaskORM,
    *,
    current_version: TaskVersionORM | None = None,
    versions: list[TaskVersionORM] | None = None,
) -> Task:
    return Task(
        task_id=row.task_id,
        name=row.name,
        description=row.description or "",
        current_version_id=row.current_version_id,
        group_id=row.group_id,
        current_version=_task_version_to_schema(current_version) if current_version else None,
        versions=(
            [_task_version_to_schema(version) for version in versions]
            if versions is not None
            else None
        ),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _apply_version_data(row: TaskVersionORM, data: TaskVersionDataSchema) -> None:
    row.system_prompt = data.system_prompt
    row.user_template = data.user_template
    row.provider_config_id = data.provider_config_id
    row.model_id = data.model_id
    row.model_parameters = data.model_parameters.model_dump(mode="json", exclude_none=True)
    row.output_contract = data.output_contract.model_dump(mode="json", exclude_none=True)
    row.image_preprocess_config = data.image_preprocess_config
    row.image_slot_specs = [spec.model_dump(mode="json") for spec in data.image_slot_specs]
    row.variable_specs = [spec.model_dump(mode="json") for spec in data.variable_specs]
    row.pricing_profile_id = data.pricing_profile_id
    row.notes = data.notes


async def _next_task_version_label(task_id: str, db: AsyncSession) -> str:
    result = await db.execute(select(TaskVersionORM).where(TaskVersionORM.task_id == task_id))
    max_number = 0
    for version in result.scalars().all():
        if version.version_label.startswith("v") and version.version_label[1:].isdigit():
            max_number = max(max_number, int(version.version_label[1:]))
    return f"v{max_number + 1}"


async def _get_task_or_404(task_id: str, db: AsyncSession) -> TaskORM:
    result = await db.execute(select(TaskORM).where(TaskORM.task_id == task_id))
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "Task not found")
    return row


async def _get_task_version_or_404(
    task_id: str,
    task_version_id: str,
    db: AsyncSession,
) -> TaskVersionORM:
    result = await db.execute(
        select(TaskVersionORM).where(
            TaskVersionORM.task_id == task_id,
            TaskVersionORM.task_version_id == task_version_id,
        )
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "Task version not found")
    return row


async def _get_task_version_by_id_or_404(
    task_version_id: str,
    db: AsyncSession,
) -> TaskVersionORM:
    result = await db.execute(
        select(TaskVersionORM).where(TaskVersionORM.task_version_id == task_version_id)
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "Task version not found")
    return row


async def _task_version_schema_by_id(task_version_id: str, db: AsyncSession) -> TaskVersion:
    return _task_version_to_schema(await _get_task_version_by_id_or_404(task_version_id, db))


async def _current_task_version(row: TaskORM, db: AsyncSession) -> TaskVersionORM | None:
    if not row.current_version_id:
        return None
    result = await db.execute(
        select(TaskVersionORM).where(
            TaskVersionORM.task_id == row.task_id,
            TaskVersionORM.task_version_id == row.current_version_id,
        )
    )
    return result.scalar_one_or_none()


@app.get("/api/tasks")
async def list_tasks(group_id: str | None = None, db: AsyncSession = Depends(get_db)):
    stmt = select(TaskORM)
    if group_id is not None:
        if group_id == "":
            stmt = stmt.where(TaskORM.group_id.is_(None))
        else:
            stmt = stmt.where(TaskORM.group_id == group_id)
    stmt = stmt.order_by(TaskORM.updated_at.desc())
    result = await db.execute(stmt)
    rows = result.scalars().all()
    current_ids = [row.current_version_id for row in rows if row.current_version_id]
    versions: dict[str, TaskVersionORM] = {}
    if current_ids:
        version_result = await db.execute(
            select(TaskVersionORM).where(TaskVersionORM.task_version_id.in_(current_ids))
        )
        versions = {row.task_version_id: row for row in version_result.scalars().all()}
    return [
        _task_to_schema(row, current_version=versions.get(row.current_version_id or "")).model_dump(
            mode="json", exclude_none=True
        )
        for row in rows
    ]


@app.post("/api/tasks")
async def create_task(payload: CreateTaskPayload, db: AsyncSession = Depends(get_db)):
    if payload.group_id is not None:
        group = await db.execute(
            select(TaskGroupORM).where(TaskGroupORM.group_id == payload.group_id)
        )
        if group.scalar_one_or_none() is None:
            raise HTTPException(404, f"Task group '{payload.group_id}' not found")
    row = TaskORM(
        task_id=f"task_{uuid4().hex[:12]}",
        name=payload.name,
        description=payload.description,
        tags=payload.tags,
        group_id=payload.group_id,
    )
    db.add(row)
    await db.flush()
    version = TaskVersionORM(
        task_version_id=f"tv_{uuid4().hex[:12]}",
        task_id=row.task_id,
        version_label="v1",
    )
    _apply_version_data(version, payload.version)
    db.add(version)
    row.current_version_id = version.task_version_id
    await db.commit()
    return _task_to_schema(row, current_version=version).model_dump(mode="json", exclude_none=True)


@app.post("/api/tasks/{task_id}/versions")
async def create_task_version(
    task_id: str,
    payload: CreateTaskVersionPayload,
    db: AsyncSession = Depends(get_db),
):
    task = await _get_task_or_404(task_id, db)
    version = TaskVersionORM(
        task_version_id=f"tv_{uuid4().hex[:12]}",
        task_id=task_id,
        version_label=await _next_task_version_label(task_id, db),
        parent_version_id=task.current_version_id,
    )
    _apply_version_data(version, payload)
    db.add(version)
    task.current_version_id = version.task_version_id
    task.updated_at = utc_now().isoformat()
    await db.commit()
    return _task_version_to_schema(version).model_dump(mode="json")


@app.get("/api/tasks/{task_id}")
async def get_task(task_id: str, db: AsyncSession = Depends(get_db)):
    row = await _get_task_or_404(task_id, db)
    version_result = await db.execute(
        select(TaskVersionORM)
        .where(TaskVersionORM.task_id == task_id)
        .order_by(TaskVersionORM.id.asc())
    )
    versions = version_result.scalars().all()
    current = next(
        (version for version in versions if version.task_version_id == row.current_version_id),
        None,
    )
    return _task_to_schema(row, current_version=current, versions=versions).model_dump(
        mode="json", exclude_none=True
    )


@app.get("/api/tasks/{task_id}/versions/{task_version_id}/input-spec", response_model=TaskInputSpec)
async def get_task_input_spec(
    task_id: str,
    task_version_id: str,
    db: AsyncSession = Depends(get_db),
):
    task = await _get_task_or_404(task_id, db)
    task_version = await _get_task_version_or_404(task_id, task_version_id, db)
    return generate_input_spec_for_task_version(task, task_version).model_dump(mode="json")


@app.get("/api/tasks/{task_id}/versions/{task_version_id}/snapshots")
async def list_task_version_snapshots(
    task_id: str,
    task_version_id: str,
    db: AsyncSession = Depends(get_db),
):
    await _get_task_version_or_404(task_id, task_version_id, db)

    # LEFT JOIN run_items + attempts so the caller gets response preview data
    # (response_text, reasoning_text, parsed_output, usage, latency_ms, status)
    # alongside each snapshot without an extra round-trip per snapshot.
    stmt = (
        select(ResultSnapshotORM, RunItemORM, AttemptORM)
        .outerjoin(
            RunItemORM,
            RunItemORM.run_item_id == ResultSnapshotORM.run_item_id,
        )
        .outerjoin(
            AttemptORM,
            (AttemptORM.attempt_id == ResultSnapshotORM.attempt_id)
            & (AttemptORM.run_item_id == ResultSnapshotORM.run_item_id),
        )
        .where(ResultSnapshotORM.linked_task_version_id == task_version_id)
        .order_by(ResultSnapshotORM.created_at.desc())
    )
    rows = (await db.execute(stmt)).all()

    snapshots: list[dict[str, Any]] = []
    for snap_row, run_item, attempt in rows:
        snap = _result_snapshot_to_schema(snap_row).model_dump(mode="json")

        response_text: str | None = None
        reasoning_text: str | None = None
        parsed_output: Any = None
        usage: dict[str, Any] | None = None
        latency_ms: int | None = None
        run_item_status: str | None = None

        if attempt is not None:
            norm_resp = attempt.normalized_response or {}
            response_text = norm_resp.get("text")
            reasoning_text = norm_resp.get("reasoning_text")
            usage = attempt.usage
            latency_ms = attempt.latency_ms
            run_item_status = attempt.status

        if run_item is not None:
            resp = run_item.response or {}
            if response_text is None:
                response_text = resp.get("raw_text")
            if reasoning_text is None:
                reasoning_text = resp.get("reasoning_text")
            parsed_output = resp.get("parsed")
            if usage is None:
                usage = run_item.usage or None
            if latency_ms is None:
                latency_ms = run_item.latency_ms
            if run_item_status is None:
                run_item_status = run_item.status

        snap["response_text"] = response_text
        snap["reasoning_text"] = reasoning_text
        snap["parsed_output"] = parsed_output
        snap["usage"] = usage
        snap["latency_ms"] = latency_ms
        snap["run_item_status"] = run_item_status
        snapshots.append(snap)

    return snapshots


@app.get("/api/tasks/{task_id}/versions/{task_version_id}/cost-stats")
async def get_task_version_cost_stats(
    task_id: str,
    task_version_id: str,
    db: AsyncSession = Depends(get_db),  # noqa: B008
):
    await _get_task_version_or_404(task_id, task_version_id, db)

    sessions_result = await db.execute(
        select(RunSessionORM).where(
            RunSessionORM.run_type.in_([RunType.BATCH.value, RunType.LAB.value]),
            # Include runs that finished with some failures: their succeeded
            # items still carry real cost data, and the item filter below
            # already excludes the failed ones.
            RunSessionORM.status.in_(
                [
                    RunSessionStatus.COMPLETED.value,
                    RunSessionStatus.COMPLETED_WITH_ERRORS.value,
                ]
            ),
        )
    )
    sessions = [
        session
        for session in sessions_result.scalars().all()
        if (session.source or {}).get("task_version_id") == task_version_id
    ]
    run_ids = [session.run_id for session in sessions]

    items: list[RunItemORM] = []
    if run_ids:
        items_result = await db.execute(
            select(RunItemORM).where(
                RunItemORM.run_id.in_(run_ids),
                RunItemORM.status.in_([RunItemType.SUCCEEDED.value, "completed"]),
            )
        )
        items = list(items_result.scalars().all())

    total_images = len(items)
    total_cost = sum(float(item.estimated_cost or 0.0) for item in items)
    avg_cost = total_cost / total_images if total_images > 0 else 0.0
    sample_count = len({item.sample_id for item in items if item.sample_id})
    currency = "USD"
    for item in items:
        snapshot = item.pricing_snapshot or {}
        if snapshot.get("currency"):
            currency = snapshot["currency"]
            break

    confidence = "none"
    if total_images >= 50:
        confidence = "high"
    elif total_images >= 10:
        confidence = "medium"
    elif total_images > 0:
        confidence = "low"

    return {
        "task_id": task_id,
        "task_version_id": task_version_id,
        "total_images": total_images,
        "total_cost": total_cost,
        "avg_cost_per_image": avg_cost,
        "avg_cost_per_request": avg_cost,
        "run_count": len(run_ids),
        "sample_count": sample_count,
        "currency": currency,
        "confidence": confidence,
    }


@app.get("/api/tasks/{task_id}/versions/{task_version_id}/export/markdown")
async def export_task_version_markdown(
    task_id: str,
    task_version_id: str,
    examples: bool = True,
    db: AsyncSession = Depends(get_db),
):
    """Export a self-contained Markdown reproduction document for a task version."""
    task = await _get_task_or_404(task_id, db)
    task_version = await _get_task_version_or_404(task_id, task_version_id, db)
    document = await generate_task_doc(
        task, task_version, db, include_examples=examples
    )
    safe_name = (task.name or task_id).replace("/", "_").replace(" ", "_")
    ascii_fallback = f"{task_id}_{task_version.version_label}.md"
    display_name = f"{safe_name}_{task_version.version_label}.md"
    content_disposition = (
        f"attachment; filename=\"{ascii_fallback}\"; "
        f"filename*=UTF-8''{quote(display_name, safe='')}"
    )
    return Response(
        content=document,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": content_disposition},
    )


@app.put("/api/tasks/{task_id}")
async def update_task(task_id: str, payload: UpdateTaskPayload, db: AsyncSession = Depends(get_db)):
    row = await _get_task_or_404(task_id, db)
    if payload.current_version_id is not None:
        await _get_task_version_or_404(task_id, payload.current_version_id, db)
        row.current_version_id = payload.current_version_id
    if payload.name is not None:
        row.name = payload.name
    if payload.description is not None:
        row.description = payload.description
    if payload.tags is not None:
        row.tags = payload.tags
    if "group_id" in payload.model_fields_set:
        if payload.group_id:
            group = await db.execute(
                select(TaskGroupORM).where(TaskGroupORM.group_id == payload.group_id)
            )
            if group.scalar_one_or_none() is None:
                raise HTTPException(404, f"Task group '{payload.group_id}' not found")
        row.group_id = payload.group_id if payload.group_id else None
    row.updated_at = utc_now().isoformat()
    await db.commit()
    current = await _current_task_version(row, db)
    return _task_to_schema(row, current_version=current).model_dump(mode="json", exclude_none=True)


class ForkTaskPayload(BaseModel):
    source_version_id: str
    name: str
    description: str = ""
    tags: list[str] = Field(default_factory=list)


@app.post("/api/tasks/{task_id}/fork")
async def fork_task(task_id: str, payload: ForkTaskPayload, db: AsyncSession = Depends(get_db)):
    """Fork a task version into a new independent task.

    Creates a new Task with a single TaskVersion that is a complete copy of
    the source version.
    """
    source_version = await _get_task_version_or_404(task_id, payload.source_version_id, db)

    # 1. Create new Task
    new_task_id = f"task_{uuid4().hex[:12]}"
    new_task = TaskORM(
        task_id=new_task_id,
        name=payload.name,
        description=payload.description,
        tags=payload.tags,
    )
    db.add(new_task)
    await db.flush()

    # 2. Create new TaskVersion (copy all config from source)
    new_version_id = f"tv_{uuid4().hex[:12]}"
    new_version = TaskVersionORM(
        task_version_id=new_version_id,
        task_id=new_task_id,
        version_label="v1",
    )
    # Copy all fields from source version
    new_version.system_prompt = source_version.system_prompt
    new_version.user_template = source_version.user_template
    new_version.provider_config_id = source_version.provider_config_id
    new_version.model_id = source_version.model_id
    new_version.model_parameters = source_version.model_parameters
    new_version.output_contract = source_version.output_contract
    new_version.image_preprocess_config = source_version.image_preprocess_config
    new_version.image_slot_specs = source_version.image_slot_specs
    new_version.variable_specs = source_version.variable_specs
    new_version.pricing_profile_id = source_version.pricing_profile_id
    new_version.notes = source_version.notes
    db.add(new_version)
    new_task.current_version_id = new_version_id

    await db.commit()
    return _task_to_schema(new_task, current_version=new_version).model_dump(
        mode="json", exclude_none=True
    )


@app.delete("/api/tasks/{task_id}")
async def delete_task(task_id: str, db: AsyncSession = Depends(get_db)):
    row = await _get_task_or_404(task_id, db)
    await db.execute(delete(TaskVersionORM).where(TaskVersionORM.task_id == task_id))
    await db.delete(row)
    await db.commit()
    return {"deleted": True}


@app.delete("/api/tasks/{task_id}/versions/{task_version_id}")
async def delete_task_version(
    task_id: str,
    task_version_id: str,
    db: AsyncSession = Depends(get_db),
):
    task = await _get_task_or_404(task_id, db)
    await _get_task_version_or_404(task_id, task_version_id, db)

    remaining_result = await db.execute(
        select(TaskVersionORM).where(
            TaskVersionORM.task_id == task_id,
            TaskVersionORM.task_version_id != task_version_id,
        )
    )
    remaining = list(remaining_result.scalars().all())
    if not remaining:
        raise HTTPException(400, "Cannot delete the only version of a task.")

    await db.execute(
        update(ResultSnapshotORM)
        .where(ResultSnapshotORM.linked_task_version_id == task_version_id)
        .values(linked_task_version_id=None)
    )

    await db.execute(
        delete(TaskVersionORM).where(TaskVersionORM.task_version_id == task_version_id)
    )

    if task.current_version_id == task_version_id:
        task.current_version_id = remaining[-1].task_version_id

    task.updated_at = utc_now().isoformat()
    await db.commit()
    return {"deleted": True}


class CreateTaskGroupPayload(BaseModel):
    name: str
    description: str = ""
    color: str = ""
    sort_order: int = 0


class UpdateTaskGroupPayload(BaseModel):
    name: str | None = None
    description: str | None = None
    color: str | None = None
    sort_order: int | None = None


def _task_group_to_schema(row: TaskGroupORM) -> TaskGroup:
    return TaskGroup(
        group_id=row.group_id,
        name=row.name,
        description=row.description or "",
        color=row.color or "",
        sort_order=row.sort_order or 0,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


@app.get("/api/task-groups")
async def list_task_groups(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(TaskGroupORM).order_by(TaskGroupORM.sort_order.asc(), TaskGroupORM.created_at.asc())
    )
    rows = result.scalars().all()
    return [_task_group_to_schema(row).model_dump(mode="json") for row in rows]


@app.post("/api/task-groups")
async def create_task_group(payload: CreateTaskGroupPayload, db: AsyncSession = Depends(get_db)):
    row = TaskGroupORM(
        group_id=f"tg_{uuid4().hex[:12]}",
        name=payload.name,
        description=payload.description,
        color=payload.color,
        sort_order=payload.sort_order,
    )
    db.add(row)
    await db.commit()
    return _task_group_to_schema(row).model_dump(mode="json")


@app.put("/api/task-groups/{group_id}")
async def update_task_group(
    group_id: str,
    payload: UpdateTaskGroupPayload,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(TaskGroupORM).where(TaskGroupORM.group_id == group_id))
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(404, f"Task group '{group_id}' not found")
    if payload.name is not None:
        row.name = payload.name
    if payload.description is not None:
        row.description = payload.description
    if payload.color is not None:
        row.color = payload.color
    if payload.sort_order is not None:
        row.sort_order = payload.sort_order
    row.updated_at = utc_now().isoformat()
    await db.commit()
    return _task_group_to_schema(row).model_dump(mode="json")


@app.delete("/api/task-groups/{group_id}")
async def delete_task_group(group_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(TaskGroupORM).where(TaskGroupORM.group_id == group_id))
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(404, f"Task group '{group_id}' not found")
    await db.execute(update(TaskORM).where(TaskORM.group_id == group_id).values(group_id=None))
    await db.delete(row)
    await db.commit()
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------
def _dict_get(data: dict[str, Any] | None, *keys: str) -> Any:
    current: Any = data or {}
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def _thumbnail_from_images(images: list[dict[str, Any]] | None) -> str | None:
    if not isinstance(images, list) or not images:
        return None
    first = images[0]
    if isinstance(first, dict):
        return first.get("uri")
    return None


def _thumbnail_from_run_item(item: RunItemORM | None) -> str | None:
    if item is None:
        return None
    images = _dict_get(item.internal_request_snapshot, "images")
    return _thumbnail_from_images(images)


def _result_snapshot_to_schema(row: ResultSnapshotORM) -> ResultSnapshotSchema:
    return ResultSnapshotSchema(
        snapshot_id=row.snapshot_id,
        run_id=row.run_id,
        run_item_id=row.run_item_id,
        attempt_id=row.attempt_id,
        name=row.name,
        description=row.description,
        tags=row.tags or [],
        starred=bool(row.starred),
        notes=row.notes,
        accepted=row.accepted,
        rating=row.rating,
        provider_id=row.provider_id,
        model_id=row.model_id,
        prompt_version_id=row.prompt_version_id,
        linked_task_version_id=row.linked_task_version_id,
        thumbnail_image_uri=row.thumbnail_image_uri,
        internal_request_snapshot=row.internal_request_snapshot,
        config_snapshot=row.config_snapshot,
        image_dir=row.image_dir,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _run_session_to_dict(session: RunSessionORM) -> dict[str, Any]:
    return {
        "run_id": session.run_id,
        "run_type": session.run_type,
        "name": session.name,
        "status": session.status,
        "started_at": session.started_at,
        "completed_at": session.completed_at,
        "source": session.source,
        "config_snapshot": session.config_snapshot,
        "summary": session.summary,
        "notes": session.notes,
        "created_at": session.created_at,
        "updated_at": session.updated_at,
    }


def _run_item_to_dict(item: RunItemORM) -> dict[str, Any]:
    return {
        "run_item_id": item.run_item_id,
        "run_id": item.run_id,
        "sample_id": item.sample_id,
        "status": item.status,
        "started_at": item.started_at,
        "completed_at": item.completed_at,
        "internal_request_snapshot": item.internal_request_snapshot,
        "prompt_snapshot": item.prompt_snapshot,
        "model_config_snapshot": item.model_config_snapshot,
        "output_contract_snapshot": item.output_contract_snapshot,
        "pricing_snapshot": item.pricing_snapshot,
        "final_attempt_id": item.final_attempt_id,
        "response": item.response,
        "usage": item.usage,
        "cost": item.cost,
        "review": item.review,
        "error": item.error,
        "compare_axes": item.compare_axes,
        "provider_id": item.provider_id,
        "model_id": item.model_id,
        "estimated_cost": item.estimated_cost,
        "latency_ms": item.latency_ms,
        "accepted": item.accepted,
        "rating": item.rating,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
    }


def _attempt_to_dict(attempt: AttemptORM) -> dict[str, Any]:
    adapter = None
    if attempt.provider_id or attempt.adapter_id or attempt.model_id:
        adapter = {
            "provider_id": attempt.provider_id,
            "adapter_id": attempt.adapter_id,
            "model_id": attempt.model_id,
        }
    return {
        "attempt_id": attempt.attempt_id,
        "run_item_id": attempt.run_item_id,
        "attempt_index": attempt.attempt_index,
        "status": attempt.status,
        "started_at": attempt.started_at,
        "completed_at": attempt.completed_at,
        "adapter": adapter,
        "provider_request_snapshot": attempt.provider_request_snapshot,
        "provider_response_raw": attempt.provider_response_raw,
        "normalized_response": attempt.normalized_response,
        "usage": attempt.usage,
        "error": attempt.error,
        "latency_ms": attempt.latency_ms,
    }


async def _get_result_snapshot_or_404(snapshot_id: str, db: AsyncSession) -> ResultSnapshotORM:
    result = await db.execute(
        select(ResultSnapshotORM).where(ResultSnapshotORM.snapshot_id == snapshot_id)
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(404, f"Result snapshot '{snapshot_id}' not found.")
    return row


@app.post("/api/result-snapshots")
async def create_result_snapshot(
    payload: CreateResultSnapshotPayload, db: AsyncSession = Depends(get_db)
):
    session_result = await db.execute(
        select(RunSessionORM).where(RunSessionORM.run_id == payload.run_id)
    )
    run_session = session_result.scalar_one_or_none()
    if run_session is None:
        raise HTTPException(404, f"Run session '{payload.run_id}' not found.")

    run_item: RunItemORM | None = None
    if payload.run_item_id:
        item_result = await db.execute(
            select(RunItemORM).where(
                RunItemORM.run_item_id == payload.run_item_id,
                RunItemORM.run_id == payload.run_id,
            )
        )
        run_item = item_result.scalar_one_or_none()
        if run_item is None:
            raise HTTPException(
                404,
                f"Run item '{payload.run_item_id}' not found for run '{payload.run_id}'.",
            )

    if payload.attempt_id:
        if not payload.run_item_id:
            raise HTTPException(400, "attempt_id requires run_item_id.")
        attempt_result = await db.execute(
            select(AttemptORM).where(
                AttemptORM.attempt_id == payload.attempt_id,
                AttemptORM.run_item_id == payload.run_item_id,
            )
        )
        if attempt_result.scalar_one_or_none() is None:
            raise HTTPException(
                404,
                f"Attempt '{payload.attempt_id}' not found for run item '{payload.run_item_id}'.",
            )

    session_model_snapshot = _dict_get(run_session.config_snapshot, "model_config_snapshot") or {}
    item_model_snapshot = run_item.model_config_snapshot if run_item else None
    provider_id = (
        (run_item.provider_id if run_item else None)
        or _dict_get(item_model_snapshot, "provider_id")
        or _dict_get(session_model_snapshot, "provider_id")
    )
    model_id = (
        (run_item.model_id if run_item else None)
        or _dict_get(item_model_snapshot, "model_id")
        or _dict_get(session_model_snapshot, "model_id")
    )
    prompt_version_id = _dict_get(
        run_session.config_snapshot, "prompt_version", "prompt_version_id"
    )
    review = run_item.review if run_item else {}
    accepted = review.get("accepted") if isinstance(review, dict) else None
    rating = review.get("rating") if isinstance(review, dict) else None
    if accepted is None and run_item is not None and run_item.accepted is not None:
        accepted = bool(run_item.accepted)
    if rating is None and run_item is not None:
        rating = run_item.rating

    snapshot_id = f"rsnap_{uuid4().hex[:16]}"
    thumbnail_image_uri = _thumbnail_from_run_item(run_item)

    row = ResultSnapshotORM(
        snapshot_id=snapshot_id,
        run_id=payload.run_id,
        run_item_id=payload.run_item_id,
        attempt_id=payload.attempt_id,
        name=payload.name,
        description=payload.description,
        tags=payload.tags,
        starred=payload.starred,
        notes=payload.notes,
        accepted=accepted,
        rating=rating,
        provider_id=provider_id,
        model_id=model_id,
        prompt_version_id=prompt_version_id,
        linked_task_version_id=payload.linked_task_version_id,
        thumbnail_image_uri=thumbnail_image_uri,
        internal_request_snapshot=None,
        config_snapshot=None,
        image_dir=None,
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)

    # Persist images and full request/config snapshots into the snapshot's own
    # directory so the bookmark survives after original upload/cache cleanup.
    settings = get_settings()
    snapshot_dir = settings.snapshots_dir / snapshot_id
    snapshot_dir.mkdir(parents=True, exist_ok=True)

    request_snapshot = (run_item.internal_request_snapshot if run_item is not None else None) or {}
    images = request_snapshot.get("images") or []
    persisted_images = persist_request_images(images, snapshot_dir)
    served_images = rewrite_image_uris(
        persisted_images, f"/api/result-snapshots/{snapshot_id}/images"
    )
    request_snapshot = {**request_snapshot, "images": served_images}

    row.internal_request_snapshot = request_snapshot
    row.config_snapshot = run_session.config_snapshot if run_session is not None else None
    row.image_dir = str(snapshot_dir)
    thumbnail_image_uri = _thumbnail_from_images(served_images)
    if thumbnail_image_uri:
        row.thumbnail_image_uri = thumbnail_image_uri
    await db.commit()
    await db.refresh(row)
    return _result_snapshot_to_schema(row).model_dump(mode="json")


@app.get("/api/result-snapshots")
async def list_result_snapshots(
    limit: int = 50,
    starred_only: bool = False,
    tag: str | None = None,
    provider_id: str | None = None,
    model_id: str | None = None,
    linked_task_version_id: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    limit = max(0, min(limit, 200))
    stmt = select(ResultSnapshotORM)
    if starred_only:
        stmt = stmt.where(ResultSnapshotORM.starred.is_(True))
    if tag:
        stmt = stmt.where(
            text(
                "EXISTS (SELECT 1 FROM json_each(result_snapshots.tags) "
                "WHERE json_each.value = :snapshot_tag)"
            )
        ).params(snapshot_tag=tag)
    if provider_id:
        stmt = stmt.where(ResultSnapshotORM.provider_id == provider_id)
    if model_id:
        stmt = stmt.where(ResultSnapshotORM.model_id == model_id)
    if linked_task_version_id:
        stmt = stmt.where(ResultSnapshotORM.linked_task_version_id == linked_task_version_id)
    stmt = stmt.order_by(ResultSnapshotORM.created_at.desc()).limit(limit)
    result = await db.execute(stmt)
    return [
        _result_snapshot_to_schema(row).model_dump(mode="json") for row in result.scalars().all()
    ]


@app.get("/api/result-snapshots/{snapshot_id}/images/{filename}")
async def serve_snapshot_image(snapshot_id: str, filename: str):
    """Serve a persisted image stored inside a result snapshot."""
    from pathlib import Path
    from fastapi.responses import FileResponse

    safe_name = Path(filename).name
    settings = get_settings()
    file_path = settings.snapshots_dir / snapshot_id / safe_name
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(404, "File not found")
    return FileResponse(file_path)


@app.get("/api/result-snapshots/{snapshot_id}/images/{filename}")
async def serve_snapshot_image(snapshot_id: str, filename: str):
    """Serve a persisted image stored inside a result snapshot."""
    from fastapi.responses import FileResponse

    safe_name = Path(filename).name
    settings = get_settings()
    file_path = settings.snapshots_dir / snapshot_id / safe_name
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(404, "File not found")
    return FileResponse(file_path)


@app.get("/api/result-snapshots/{snapshot_id}")
async def get_result_snapshot(snapshot_id: str, db: AsyncSession = Depends(get_db)):
    snapshot = await _get_result_snapshot_or_404(snapshot_id, db)

    session_result = await db.execute(
        select(RunSessionORM).where(RunSessionORM.run_id == snapshot.run_id)
    )
    run_session = session_result.scalar_one_or_none()
    if run_session is None:
        raise HTTPException(404, f"Source run session '{snapshot.run_id}' not found.")

    run_item = None
    if snapshot.run_item_id:
        item_result = await db.execute(
            select(RunItemORM).where(
                RunItemORM.run_item_id == snapshot.run_item_id,
                RunItemORM.run_id == snapshot.run_id,
            )
        )
        run_item = item_result.scalar_one_or_none()
        if run_item is None:
            raise HTTPException(404, f"Source run item '{snapshot.run_item_id}' not found.")

    attempt = None
    if snapshot.attempt_id and snapshot.run_item_id:
        attempt_result = await db.execute(
            select(AttemptORM).where(
                AttemptORM.attempt_id == snapshot.attempt_id,
                AttemptORM.run_item_id == snapshot.run_item_id,
            )
        )
        attempt = attempt_result.scalar_one_or_none()
        if attempt is None:
            raise HTTPException(404, f"Source attempt '{snapshot.attempt_id}' not found.")

    return {
        "snapshot": _result_snapshot_to_schema(snapshot).model_dump(mode="json"),
        "run_session": _run_session_to_dict(run_session),
        "run_item": _run_item_to_dict(run_item) if run_item else None,
        "attempt": _attempt_to_dict(attempt) if attempt else None,
    }


@app.patch("/api/result-snapshots/{snapshot_id}")
async def update_result_snapshot(
    snapshot_id: str,
    payload: UpdateResultSnapshotPayload,
    db: AsyncSession = Depends(get_db),
):
    row = await _get_result_snapshot_or_404(snapshot_id, db)
    fields = payload.model_fields_set
    if "name" in fields:
        row.name = payload.name or ""
    if "description" in fields:
        row.description = payload.description or ""
    if "tags" in fields:
        row.tags = payload.tags or []
    if "notes" in fields:
        row.notes = payload.notes or ""
    if "starred" in fields:
        row.starred = bool(payload.starred)
    if "accepted" in fields:
        row.accepted = payload.accepted
    if "rating" in fields:
        row.rating = payload.rating
    if "linked_task_version_id" in fields:
        row.linked_task_version_id = payload.linked_task_version_id
    row.updated_at = datetime.utcnow().isoformat()
    await db.commit()
    await db.refresh(row)
    return _result_snapshot_to_schema(row).model_dump(mode="json")


@app.delete("/api/result-snapshots/{snapshot_id}")
async def delete_result_snapshot(snapshot_id: str, db: AsyncSession = Depends(get_db)):
    row = await _get_result_snapshot_or_404(snapshot_id, db)
    await db.delete(row)
    await db.commit()
    return {"deleted": True}


@app.get("/api/runs")
async def list_runs(
    run_type: str | None = None,
    status: str | None = None,
    search: str | None = None,
    limit: int = 50,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
):
    filters = []
    if run_type:
        filters.append(RunSessionORM.run_type == run_type)
    if status:
        filters.append(RunSessionORM.status == status)
    if search:
        needle = f"%{search.lower()}%"
        filters.append(
            or_(
                func.lower(RunSessionORM.run_id).like(needle),
                func.lower(RunSessionORM.name).like(needle),
            )
        )

    total_stmt = select(func.count()).select_from(RunSessionORM)
    stmt = (
        select(RunSessionORM).order_by(RunSessionORM.created_at.desc()).limit(limit).offset(offset)
    )
    if filters:
        total_stmt = total_stmt.where(*filters)
        stmt = stmt.where(*filters)

    total_result = await db.execute(total_stmt)
    total = int(total_result.scalar_one())
    result = await db.execute(stmt)
    rows = result.scalars().all()
    runs = []
    for row in rows:
        data = _run_session_to_dict(row)
        runs.append(
            {
                "run_id": data["run_id"],
                "run_type": data["run_type"],
                "name": data["name"],
                "status": data["status"],
                "started_at": data["started_at"],
                "completed_at": data["completed_at"],
                "summary": data["summary"],
                "created_at": data["created_at"],
            }
        )
    return {"total": total, "runs": runs}


async def _get_run_session_and_items_or_404(
    run_id: str,
    db: AsyncSession,
) -> tuple[RunSessionORM, list[RunItemORM]]:
    stmt = select(RunSessionORM).where(RunSessionORM.run_id == run_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, "Run session not found")

    items_stmt = select(RunItemORM).where(RunItemORM.run_id == run_id)
    items_result = await db.execute(items_stmt)
    return session, list(items_result.scalars().all())


@app.get("/api/runs/{run_id}")
async def get_run(run_id: str, db: AsyncSession = Depends(get_db)):
    session, items = await _get_run_session_and_items_or_404(run_id, db)

    return {
        "session": {
            "run_id": session.run_id,
            "run_type": session.run_type,
            "name": session.name,
            "status": session.status,
            "started_at": session.started_at,
            "completed_at": session.completed_at,
            "source": session.source,
            "config_snapshot": session.config_snapshot,
            "summary": session.summary,
            "notes": session.notes,
            "created_at": session.created_at,
        },
        "items": [
            {
                "run_item_id": i.run_item_id,
                "run_id": i.run_id,
                "sample_id": i.sample_id,
                "status": i.status,
                "started_at": i.started_at,
                "completed_at": i.completed_at,
                "prompt_snapshot": i.prompt_snapshot,
                "internal_request_snapshot": i.internal_request_snapshot,
                "model_config_snapshot": i.model_config_snapshot,
                "output_contract_snapshot": i.output_contract_snapshot,
                "final_attempt_id": i.final_attempt_id,
                "response": i.response,
                "usage": i.usage,
                "cost": i.cost,
                "review": i.review,
                "error": i.error,
                "provider_id": i.provider_id,
                "model_id": i.model_id,
                "estimated_cost": i.estimated_cost,
                "latency_ms": i.latency_ms,
                "created_at": i.created_at,
            }
            for i in items
        ],
    }


@app.delete("/api/runs/{run_id}")
async def delete_run(run_id: str, db: AsyncSession = Depends(get_db)):
    session, items = await _get_run_session_and_items_or_404(run_id, db)
    run_item_ids = [item.run_item_id for item in items]
    if run_item_ids:
        await db.execute(delete(AttemptORM).where(AttemptORM.run_item_id.in_(run_item_ids)))
    await db.execute(delete(RunItemORM).where(RunItemORM.run_id == run_id))
    await db.delete(session)
    await db.commit()
    return {"deleted": True}


@app.get("/api/runs/{run_id}/export/jsonl")
async def export_run_jsonl(run_id: str, db: AsyncSession = Depends(get_db)):
    session, items = await _get_run_session_and_items_or_404(run_id, db)
    session_data = _run_session_to_dict(session)
    lines = []
    for item in items:
        item_data = _run_item_to_dict(item)
        # Extract input information from the internal request snapshot so the
        # exported record is self-contained: the reader can associate each
        # model response with the images and variables that produced it.
        req_snap = item_data.get("internal_request_snapshot") or {}
        input_images = []
        for img in req_snap.get("images") or []:
            if not isinstance(img, dict):
                continue
            resolved = img.get("resolved") or {}
            input_images.append(
                {
                    "request_image_id": img.get("request_image_id"),
                    "source_image_id": img.get("source_image_id"),
                    "role": img.get("role"),
                    "path": img.get("path"),
                    "mime_type": resolved.get("mime_type") or img.get("mime_type"),
                    "display_name": img.get("display_name"),
                    "order": img.get("order"),
                }
            )
        prompt_spec = req_snap.get("prompt") or {}
        render_context = prompt_spec.get("render_context") or {}
        lines.append(
            json.dumps(
                {
                    "run_id": session_data["run_id"],
                    "run_item_id": item_data["run_item_id"],
                    "sample_id": item_data["sample_id"],
                    "status": item_data["status"],
                    "model_id": item_data["model_id"],
                    "provider_id": item_data["provider_id"],
                    "input": {
                        "images": input_images,
                        "vars": render_context.get("vars") or {},
                        "system_prompt": prompt_spec.get("system_prompt"),
                        "user_prompt": prompt_spec.get("user_prompt"),
                    },
                    "response": item_data["response"] or {},
                    "usage": item_data["usage"] or {},
                    "cost": item_data["cost"] or {},
                    "review": item_data["review"] or {},
                    "error": item_data["error"],
                    "latency_ms": item_data["latency_ms"],
                    "created_at": item_data["created_at"],
                },
                ensure_ascii=False,
            )
        )
    content = "\n".join(lines)
    if content:
        content += "\n"
    return Response(
        content=content,
        media_type="text/plain",
        headers={"Content-Disposition": f'attachment; filename="run_{run_id}.jsonl"'},
    )


def _csv_value(value: Any) -> Any:
    if value is None or isinstance(value, str | int | float | bool):
        return value
    return json.dumps(value, ensure_ascii=False)


@app.get("/api/runs/{run_id}/export/csv")
async def export_run_csv(run_id: str, db: AsyncSession = Depends(get_db)):
    session, items = await _get_run_session_and_items_or_404(run_id, db)
    session_data = _run_session_to_dict(session)
    session_summary = session_data["summary"] or {}
    fieldnames = [
        "run_id",
        "run_item_id",
        "sample_id",
        "status",
        "model_id",
        "provider_id",
        "input_images",
        "input_vars",
        "system_prompt",
        "user_prompt",
        "latency_ms",
        "input_tokens",
        "output_tokens",
        "total_tokens",
        "estimated_cost",
        "currency",
        "raw_text",
        "parsed_text",
        "error_message",
        "accepted",
        "rating",
        "labels",
        "created_at",
    ]
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=fieldnames)
    writer.writeheader()
    for item in items:
        item_data = _run_item_to_dict(item)
        response_data = item_data["response"] or {}
        usage = item_data["usage"] or {}
        cost = item_data["cost"] or {}
        review = item_data["review"] or {}
        error = item_data["error"] or {}
        labels = review.get("labels", [])
        if not isinstance(labels, list):
            labels = [labels]
        # Extract input information from the internal request snapshot.
        req_snap = item_data.get("internal_request_snapshot") or {}
        prompt_spec = req_snap.get("prompt") or {}
        render_context = prompt_spec.get("render_context") or {}
        input_images = []
        for img in req_snap.get("images") or []:
            if not isinstance(img, dict):
                continue
            resolved = img.get("resolved") or {}
            path = img.get("path") or ""
            role = img.get("role") or ""
            input_images.append(f"{role}:{path}")
        input_vars = render_context.get("vars") or {}
        writer.writerow(
            {
                "run_id": session_data["run_id"],
                "run_item_id": item_data["run_item_id"],
                "sample_id": item_data["sample_id"],
                "status": item_data["status"],
                "model_id": item_data["model_id"],
                "provider_id": item_data["provider_id"],
                "input_images": "; ".join(input_images),
                "input_vars": _csv_value(input_vars),
                "system_prompt": prompt_spec.get("system_prompt"),
                "user_prompt": prompt_spec.get("user_prompt"),
                "latency_ms": item_data["latency_ms"],
                "input_tokens": usage.get("input_tokens"),
                "output_tokens": usage.get("output_tokens"),
                "total_tokens": usage.get("total_tokens"),
                "estimated_cost": item_data["estimated_cost"],
                "currency": cost.get("currency") or session_summary.get("currency") or "USD",
                "raw_text": response_data.get("raw_text"),
                "parsed_text": _csv_value(response_data.get("parsed")),
                "error_message": error.get("message"),
                "accepted": review.get("accepted"),
                "rating": review.get("rating"),
                "labels": ",".join(str(label) for label in labels),
                "created_at": item_data["created_at"],
            }
        )
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="run_{run_id}.csv"'},
    )

@app.get("/api/runs/{run_id}/export/html")
async def export_run_html(run_id: str, db: AsyncSession = Depends(get_db)):
    """Render a self-contained, distributable HTML visualization of a run."""
    session, items = await _get_run_session_and_items_or_404(run_id, db)
    session_data = _run_session_to_dict(session)
    items_data = [_run_item_to_dict(item) for item in items]
    content = render_run_html(session_data, items_data)
    return Response(
        content=content,
        media_type="text/html",
        headers={"Content-Disposition": f'attachment; filename="run_{run_id}.html"'},
    )


@app.get("/api/runs/{run_id}/items/{run_item_id}")
async def get_run_item(run_id: str, run_item_id: str, db: AsyncSession = Depends(get_db)):
    stmt = select(RunItemORM).where(
        RunItemORM.run_id == run_id, RunItemORM.run_item_id == run_item_id
    )
    result = await db.execute(stmt)
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(404, "Run item not found")
    return {
        "run_item_id": item.run_item_id,
        "run_id": item.run_id,
        "sample_id": item.sample_id,
        "status": item.status,
        "internal_request_snapshot": item.internal_request_snapshot,
        "prompt_snapshot": item.prompt_snapshot,
        "model_config_snapshot": item.model_config_snapshot,
        "response": item.response,
        "usage": item.usage,
        "cost": item.cost,
        "review": item.review,
        "error": item.error,
        "estimated_cost": item.estimated_cost,
        "latency_ms": item.latency_ms,
        "created_at": item.created_at,
    }


@app.patch("/api/runs/{run_id}/items/{run_item_id}/review")
async def update_review(
    run_id: str,
    run_item_id: str,
    payload: UpdateReviewPayload,
    db: AsyncSession = Depends(get_db),
):
    stmt = select(RunItemORM).where(
        RunItemORM.run_id == run_id, RunItemORM.run_item_id == run_item_id
    )
    result = await db.execute(stmt)
    item = result.scalar_one_or_none()
    if not item:
        raise HTTPException(404, "Run item not found")

    review = item.review or {}
    if payload.accepted is not None:
        review["accepted"] = payload.accepted
        item.accepted = 1 if payload.accepted else 0
    if payload.rating is not None:
        review["rating"] = payload.rating
        item.rating = payload.rating
    if payload.labels:
        review["labels"] = payload.labels
    if payload.notes:
        review["notes"] = payload.notes
    review["reviewed_at"] = datetime.utcnow().isoformat()
    item.review = review
    await db.commit()
    return review


# ---------------------------------------------------------------------------
# Samples
# ---------------------------------------------------------------------------


def _sample_set_to_dict(row: SampleSetORM) -> dict[str, Any]:
    return {
        "sample_set_id": row.sample_set_id,
        "name": row.name,
        "description": row.description,
        "record_ids": row.record_ids,
        "metadata": row.metadata_,
        "created_at": row.created_at,
    }


def _dedupe_record_ids(records: list[SampleRecord]) -> None:
    seen: set[str] = set()
    for index, record in enumerate(records):
        sample_id = record.sample_id
        if sample_id not in seen:
            seen.add(sample_id)
            continue

        digest_source = f"{sample_id}:{index}:{record.model_dump_json()}".encode("utf-8")
        suffix = hashlib.sha1(digest_source).hexdigest()[:6]
        candidate = f"{sample_id}_{suffix}"
        counter = 1
        while candidate in seen:
            candidate = f"{sample_id}_{suffix}{counter}"
            counter += 1
        record.sample_id = candidate
        seen.add(candidate)


def _copy_upload_file(upload: UploadFile, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    upload.file.seek(0)
    with destination.open("wb") as out_file:
        shutil.copyfileobj(upload.file, out_file)


def _remove_file(path: Path) -> None:
    path.unlink(missing_ok=True)


async def _save_upload_to_temp(upload: UploadFile) -> Path:
    suffix = Path(upload.filename or "upload").suffix
    temp_path = settings.data_dir / "temp" / f"upload_{uuid4().hex[:12]}{suffix}"
    await run_in_threadpool(_copy_upload_file, upload, temp_path)
    return temp_path


async def _persist_sample_records(
    db: AsyncSession,
    records: list[SampleRecord],
    *,
    name: str,
    import_source: dict[str, Any],
) -> str:
    sample_set_id = f"ss_{uuid4().hex[:12]}"
    set_orm = SampleSetORM(
        sample_set_id=sample_set_id,
        name=name,
        import_source=import_source,
        record_ids=[r.sample_id for r in records],
    )
    db.add(set_orm)

    for record in records:
        record.sample_set_id = sample_set_id
        orm = SampleRecordORM(
            sample_id=record.sample_id,
            sample_set_id=sample_set_id,
            sample_type=record.sample_type,
            data=record.model_dump(mode="json"),
            tags=record.tags,
            notes=record.notes,
        )
        db.add(orm)

    await db.commit()
    return sample_set_id


@app.get("/api/samples")
async def list_samples(
    sample_set_id: str | None = None, limit: int = 100, db: AsyncSession = Depends(get_db)
):
    stmt = select(SampleRecordORM)
    if sample_set_id:
        stmt = stmt.where(SampleRecordORM.sample_set_id == sample_set_id)
    stmt = stmt.order_by(SampleRecordORM.created_at.desc()).limit(limit)
    result = await db.execute(stmt)
    return [
        {
            "sample_id": r.sample_id,
            "sample_set_id": r.sample_set_id,
            "sample_type": r.sample_type,
            "data": r.data,
            "tags": r.tags,
            "notes": r.notes,
            "created_at": r.created_at,
        }
        for r in result.scalars().all()
    ]


@app.post("/api/samples")
async def create_sample(sample: SampleRecord, db: AsyncSession = Depends(get_db)):
    orm = SampleRecordORM(
        sample_id=sample.sample_id,
        sample_type=sample.sample_type,
        data=sample.model_dump(mode="json"),
        tags=sample.tags,
        notes=sample.notes,
    )
    db.add(orm)
    await db.commit()
    return {"sample_id": sample.sample_id, "created": True}


@app.get("/api/sample-sets")
async def list_sample_sets(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(SampleSetORM).order_by(SampleSetORM.created_at.desc()))
    return [_sample_set_to_dict(r) for r in result.scalars().all()]


@app.get("/api/sample-sets/{sample_set_id}")
async def get_sample_set(sample_set_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(SampleSetORM).where(SampleSetORM.sample_set_id == sample_set_id)
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "Sample set not found")
    return _sample_set_to_dict(row)


@app.delete("/api/sample-sets/{sample_set_id}")
async def delete_sample_set(sample_set_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(SampleSetORM).where(SampleSetORM.sample_set_id == sample_set_id)
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "Sample set not found")
    await db.execute(delete(SampleRecordORM).where(SampleRecordORM.sample_set_id == sample_set_id))
    await db.delete(row)
    await db.commit()
    return {"deleted": True}


@app.put("/api/sample-sets/{sample_set_id}")
async def update_sample_set(sample_set_id: str, payload: dict, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(SampleSetORM).where(SampleSetORM.sample_set_id == sample_set_id)
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "Sample set not found")
    if "name" in payload and isinstance(payload["name"], str):
        row.name = payload["name"]
    if "description" in payload and isinstance(payload["description"], str):
        row.description = payload["description"]
    row.updated_at = utc_now().isoformat()
    await db.commit()
    await db.refresh(row)
    return _sample_set_to_dict(row)


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------


def _prompt_to_dict(prompt: PromptORM) -> dict[str, Any]:
    return {
        "prompt_id": prompt.prompt_id,
        "name": prompt.name,
        "system_prompt": prompt.system_prompt,
        "user_template": prompt.user_template,
        "notes": prompt.notes,
        "tags": prompt.tags,
        "created_at": prompt.created_at,
        "updated_at": prompt.updated_at,
    }


@app.get("/api/prompts")
async def list_prompts(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(PromptORM).order_by(PromptORM.created_at.desc()))
    return [_prompt_to_dict(prompt) for prompt in result.scalars().all()]


@app.get("/api/prompts/{prompt_id}")
async def get_prompt(prompt_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(PromptORM).where(PromptORM.prompt_id == prompt_id))
    prompt = result.scalar_one_or_none()
    if prompt is None:
        raise HTTPException(404, f"Prompt '{prompt_id}' not found.")

    return _prompt_to_dict(prompt)


@app.post("/api/prompts")
async def save_prompt(payload: SavePromptPayload, db: AsyncSession = Depends(get_db)):
    prompt_id = payload.prompt_id or f"prompt_{uuid4().hex[:12]}"

    stmt = select(PromptORM).where(PromptORM.prompt_id == prompt_id)
    result = await db.execute(stmt)
    prompt = result.scalar_one_or_none()
    created = prompt is None

    if created:
        prompt = PromptORM(
            prompt_id=prompt_id,
            name=payload.name,
            system_prompt=payload.system_prompt,
            user_template=payload.user_template,
            notes=payload.notes,
        )
        db.add(prompt)
    else:
        prompt.name = payload.name
        prompt.system_prompt = payload.system_prompt
        prompt.user_template = payload.user_template
        prompt.notes = payload.notes
        prompt.updated_at = utc_now().isoformat()
    await db.commit()

    return {
        "prompt_id": prompt_id,
        "created": created,
    }


@app.delete("/api/prompts/{prompt_id}")
async def delete_prompt(prompt_id: str, db: AsyncSession = Depends(get_db)):
    """Delete a prompt snippet."""
    result = await db.execute(select(PromptORM).where(PromptORM.prompt_id == prompt_id))
    prompt = result.scalar_one_or_none()
    if prompt is None:
        raise HTTPException(404, f"Prompt '{prompt_id}' not found.")

    await db.delete(prompt)
    await db.commit()

    return {"deleted": True}


# ---------------------------------------------------------------------------
# Model configs
# ---------------------------------------------------------------------------


@app.get("/api/model-configs")
async def list_model_configs(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(ModelConfigORM).order_by(ModelConfigORM.created_at.desc()))
    return [
        {
            "model_config_id": r.model_config_id,
            "name": r.name,
            "provider_id": r.provider_id,
            "model_id": r.model_id,
            "adapter_id": r.adapter_id,
            "parameters": r.parameters,
            "provider_options": r.provider_options,
            "notes": r.notes,
            "created_at": r.created_at,
        }
        for r in result.scalars().all()
    ]


@app.post("/api/model-configs")
async def save_model_config(payload: CreateModelConfigPayload, db: AsyncSession = Depends(get_db)):
    config_id = f"mc_{uuid4().hex[:12]}"
    orm = ModelConfigORM(
        model_config_id=config_id,
        name=payload.name,
        provider_id=payload.provider_id,
        model_id=payload.model_id,
        adapter_id=payload.adapter_id,
        parameters=payload.parameters.model_dump(exclude_none=True),
        provider_options=payload.provider_options,
        notes=payload.notes,
    )
    db.add(orm)
    await db.commit()
    return {"model_config_id": config_id, "created": True}


# ---------------------------------------------------------------------------
# Pricing
# ---------------------------------------------------------------------------


@app.get("/api/pricing")
async def list_pricing(
    provider_config_id: str | None = None,
    model_id: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    stmt = select(PricingProfileORM)
    if provider_config_id:
        stmt = stmt.where(PricingProfileORM.provider_config_id == provider_config_id)
    if model_id:
        stmt = stmt.where(PricingProfileORM.model_id == model_id)
    result = await db.execute(stmt.order_by(PricingProfileORM.created_at.desc()))
    return [
        {
            "pricing_profile_id": r.pricing_profile_id,
            "provider_id": r.provider_id,
            "provider_config_id": r.provider_config_id,
            "model_id": r.model_id,
            "currency": r.currency,
            "effective_date": r.effective_date,
            "input_token_price": r.input_token_price,
            "output_token_price": r.output_token_price,
            "cached_input_price": r.cached_input_price,
            "batch_discount": r.batch_discount,
            "image_pricing": r.image_pricing,
            "notes": r.notes,
            "created_at": r.created_at,
        }
        for r in result.scalars().all()
    ]


@app.post("/api/pricing")
async def save_pricing(payload: CreatePricingPayload, db: AsyncSession = Depends(get_db)):
    provider_id = payload.provider_id or payload.provider_config_id or ""
    if not provider_id:
        raise HTTPException(400, "provider_id or provider_config_id is required")
    lookup = select(PricingProfileORM).where(PricingProfileORM.model_id == payload.model_id)
    if payload.provider_config_id:
        lookup = lookup.where(PricingProfileORM.provider_config_id == payload.provider_config_id)
    else:
        lookup = lookup.where(PricingProfileORM.provider_id == provider_id)
    result = await db.execute(lookup.order_by(PricingProfileORM.created_at.desc()).limit(1))
    orm = result.scalar_one_or_none()
    created = orm is None
    if orm is None:
        orm = PricingProfileORM(
            pricing_profile_id=f"pp_{uuid4().hex[:12]}",
            provider_id=provider_id,
            provider_config_id=payload.provider_config_id,
            model_id=payload.model_id,
        )
        db.add(orm)
    orm.provider_id = provider_id
    orm.provider_config_id = payload.provider_config_id
    orm.currency = payload.currency
    orm.input_token_price = payload.input_token_price
    orm.output_token_price = payload.output_token_price
    orm.cached_input_price = payload.cached_input_price
    orm.batch_discount = payload.batch_discount
    orm.image_pricing = payload.image_pricing
    orm.notes = payload.notes
    await db.commit()
    return {"pricing_profile_id": orm.pricing_profile_id, "created": created}


@app.delete("/api/pricing/{pricing_profile_id}")
async def delete_pricing(pricing_profile_id: str, db: AsyncSession = Depends(get_db)):
    stmt = select(PricingProfileORM).where(
        PricingProfileORM.pricing_profile_id == pricing_profile_id
    )
    result = await db.execute(stmt)
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "Pricing profile not found")
    await db.delete(row)
    await db.commit()
    return {"deleted": True}


# ---------------------------------------------------------------------------
# API keys
# ---------------------------------------------------------------------------


@app.get("/api/settings/api-keys")
async def list_api_keys(db: AsyncSession = Depends(get_db)):
    providers = await list_api_key_providers(db)
    return {"providers": providers}


@app.put("/api/settings/api-keys/{provider_id}")
async def set_api_key(provider_id: str, payload: ApiKeyPayload, db: AsyncSession = Depends(get_db)):
    await store_api_key(db, provider_id, payload.api_key)
    await db.commit()
    return {"provider_id": provider_id, "masked": mask_api_key(payload.api_key)}


@app.delete("/api/settings/api-keys/{provider_id}")
async def remove_api_key(provider_id: str, db: AsyncSession = Depends(get_db)):
    deleted = await delete_api_key(db, provider_id)
    await db.commit()
    if not deleted:
        raise HTTPException(404, "API key not found")
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Image upload
# ---------------------------------------------------------------------------


@app.post("/api/upload/image")
async def upload_image(file: UploadFile = File(...)):
    import mimetypes
    from pathlib import Path

    settings = get_settings()
    ext = Path(file.filename or "image.png").suffix
    saved_name = f"{uuid4().hex}{ext}"
    saved_path = settings.uploads_dir / saved_name

    content = await file.read()
    saved_path.write_bytes(content)

    mime = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "image/png"

    import hashlib as _hashlib

    return {
        "path": str(saved_path),
        "filename": file.filename,
        "mime_type": mime,
        "size": len(content),
        "sha256": _hashlib.sha256(content).hexdigest(),
        "url": f"/api/uploads/{saved_name}",
    }


@app.get("/api/uploads/{filename}")
async def serve_upload(filename: str):
    """Serve an uploaded image file."""
    from pathlib import Path
    from fastapi.responses import FileResponse

    # Prevent path traversal
    safe_name = Path(filename).name
    settings = get_settings()
    file_path = settings.uploads_dir / safe_name
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(404, "File not found")
    return FileResponse(file_path)


@app.get("/api/sample-images")
async def serve_sample_image(path: str):
    """Serve a sample image from an arbitrary filesystem path.

    This endpoint allows the frontend to display images referenced by
    absolute paths in JSONL/CSV imports, which cannot be loaded via
    ``file://`` URLs due to browser security restrictions.
    """
    from pathlib import Path
    from fastapi.responses import FileResponse

    file_path = Path(path).expanduser()
    # Security: only allow image files, prevent directory listing
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(404, "Image file not found")
    # Basic extension check to prevent serving arbitrary files
    allowed_suffixes = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".tif"}
    if file_path.suffix.lower() not in allowed_suffixes:
        raise HTTPException(403, "Only image files are allowed")
    return FileResponse(file_path)


# ---------------------------------------------------------------------------
# Provider configs (bundle adapter + base_url + api_key)
# ---------------------------------------------------------------------------

from app.models.provider_config import ProviderConfigORM as _PCORM
from app.core.security import (
    encrypt_value as _encrypt,
    decrypt_value as _decrypt,
    mask_api_key as _mask,
)


@app.get("/api/provider-configs")
async def list_provider_configs(db: AsyncSession = Depends(get_db)):
    """List all provider configs (api_key is never returned in plaintext)."""
    stmt = select(_PCORM).order_by(_PCORM.created_at.desc())
    result = await db.execute(stmt)
    rows = result.scalars().all()
    return [
        {
            "provider_config_id": r.provider_config_id,
            "name": r.name,
            "adapter_id": r.adapter_id,
            "base_url": r.base_url,
            "api_key_set": bool(r.api_key_encrypted),
            "api_key_masked": _mask(_decrypt(r.api_key_encrypted)) if r.api_key_encrypted else "",
            "cached_models": r.cached_models or [],
            "selected_models": r.selected_models or [],
            "models_cached_at": r.models_cached_at.isoformat() if r.models_cached_at else None,
            "notes": r.notes,
            "created_at": r.created_at,
        }
        for r in rows
    ]


class SaveProviderConfigPayload(BaseModel):
    name: str
    adapter_id: str = "openai"
    base_url: str | None = None
    api_key: str | None = None  # None on update = keep existing
    selected_models: list[str] = Field(default_factory=list)
    notes: str = ""
    provider_config_id: str | None = None  # None = create new
    cached_models: list[str] | None = (
        None  # None = keep existing; set to merge manually-added models
    )


@app.post("/api/provider-configs")
async def save_provider_config(
    payload: SaveProviderConfigPayload, db: AsyncSession = Depends(get_db)
):
    """Create or update a provider config."""

    from app.adapters.registry import get_adapter_metadata

    # Validate adapter
    meta = get_adapter_metadata(payload.adapter_id)
    if meta is None:
        raise HTTPException(400, f"Unknown adapter '{payload.adapter_id}'")
    if meta.get("requires_base_url") and not payload.base_url:
        raise HTTPException(400, f"Adapter '{payload.adapter_id}' requires base_url.")

    if payload.provider_config_id:
        # Update existing
        stmt = select(_PCORM).where(_PCORM.provider_config_id == payload.provider_config_id)
        result = await db.execute(stmt)
        row = result.scalar_one_or_none()
        if row is None:
            raise HTTPException(404, "Provider config not found")
        row.name = payload.name
        row.adapter_id = payload.adapter_id
        row.base_url = payload.base_url
        row.selected_models = payload.selected_models
        row.notes = payload.notes
        if payload.api_key is not None:
            row.api_key_encrypted = _encrypt(payload.api_key)
        if payload.cached_models is not None:
            row.cached_models = payload.cached_models
    else:
        # Create new
        config_id = f"pc_{uuid4().hex[:12]}"
        encrypted_key = _encrypt(payload.api_key) if payload.api_key else None
        row = _PCORM(
            provider_config_id=config_id,
            name=payload.name,
            adapter_id=payload.adapter_id,
            base_url=payload.base_url,
            api_key_encrypted=encrypted_key,
            selected_models=payload.selected_models,
            notes=payload.notes,
        )
        db.add(row)

    await db.commit()
    return {
        "provider_config_id": row.provider_config_id,
        "name": row.name,
        "adapter_id": row.adapter_id,
        "base_url": row.base_url,
        "api_key_set": bool(row.api_key_encrypted),
        "cached_models": row.cached_models or [],
        "selected_models": row.selected_models or [],
        "models_cached_at": row.models_cached_at.isoformat() if row.models_cached_at else None,
        "created": payload.provider_config_id is None,
    }


@app.delete("/api/provider-configs/{config_id}")
async def delete_provider_config(config_id: str, db: AsyncSession = Depends(get_db)):
    stmt = select(_PCORM).where(_PCORM.provider_config_id == config_id)
    result = await db.execute(stmt)
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "Provider config not found")
    await db.delete(row)
    await db.commit()
    return {"deleted": True}


# ---------------------------------------------------------------------------
# CSV import
# ---------------------------------------------------------------------------


@app.post("/api/import/csv/preview")
async def csv_preview(payload: dict):
    csv_path = payload.get("csv_path", "")
    delimiter = payload.get("delimiter", ",")
    columns, rows = preview_csv(csv_path, n_rows=5, delimiter=delimiter)
    return {"columns": columns, "rows": rows}


@app.post("/api/import/csv/suggest-mapping")
async def csv_suggest_mapping(payload: dict, db: AsyncSession = Depends(get_db)):
    columns = payload.get("columns")
    if columns is None:
        csv_path = payload.get("csv_path", "")
        delimiter = payload.get("delimiter", ",")
        columns = detect_columns(csv_path, delimiter=delimiter)
    task_version = None
    task_version_id = payload.get("task_version_id")
    if task_version_id:
        task_version = await _task_version_schema_by_id(task_version_id, db)
    mapping = suggest_column_mapping(
        list(columns or []),
        task_version.image_slot_specs if task_version else None,
        task_version.variable_specs if task_version else None,
    )
    if task_version_id:
        mapping.task_version_id = task_version_id
    return mapping.model_dump(mode="json")


async def _validation_report_for_records(
    records: list[SampleRecord],
    task_version_id: str | None,
    db: AsyncSession,
) -> ImportValidationReport | None:
    if not task_version_id:
        return None
    task_version = await _task_version_schema_by_id(task_version_id, db)
    valid_records, invalid_rows = validate_records_against_contract(
        records,
        task_version.image_slot_specs,
        task_version.variable_specs,
    )
    return ImportValidationReport(valid_count=len(valid_records), invalid_rows=invalid_rows)


@app.post("/api/import/csv/preview/file")
async def csv_preview_file(
    file: UploadFile = File(...),
    delimiter: str = Form(","),
):
    temp_path = await _save_upload_to_temp(file)
    try:
        columns, rows = await run_in_threadpool(preview_csv, temp_path, 5, delimiter)
        return {"columns": columns, "rows": rows}
    finally:
        await run_in_threadpool(_remove_file, temp_path)


@app.post("/api/import/csv")
async def csv_import(payload: CsvImportPayload, db: AsyncSession = Depends(get_db)):
    records = import_csv(payload.csv_path, payload.mapping, payload.delimiter)
    task_version_id = payload.task_version_id or payload.mapping.task_version_id
    report = await _validation_report_for_records(records, task_version_id, db)
    if payload.validate_only:
        return (report or ImportValidationReport(valid_count=len(records))).model_dump(mode="json")

    sample_set_id = await _persist_sample_records(
        db,
        records,
        name=payload.sample_set_name or f"Import {datetime.utcnow().isoformat()}",
        import_source={"type": "csv", "path": payload.csv_path},
    )
    return {
        "sample_set_id": sample_set_id,
        "imported_count": len(records),
        **({"validation": report.model_dump(mode="json")} if report is not None else {}),
    }


@app.post("/api/import/csv/file")
async def csv_import_file(
    file: UploadFile = File(...),
    delimiter: str = Form(","),
    mapping: str = Form(...),
    task_version_id: str | None = Form(None),
    validate_only: bool = Form(False),
    sample_set_name: str = Form(""),
    db: AsyncSession = Depends(get_db),
):
    try:
        mapping_data = json.loads(mapping)
        parsed_mapping = ColumnMapping.model_validate(mapping_data)
    except Exception as exc:
        raise HTTPException(400, f"Invalid mapping: {exc}") from exc

    temp_path = await _save_upload_to_temp(file)
    try:
        records = await run_in_threadpool(import_csv, temp_path, parsed_mapping, delimiter)
        effective_task_version_id = task_version_id or parsed_mapping.task_version_id
        report = await _validation_report_for_records(records, effective_task_version_id, db)
        if validate_only:
            return (report or ImportValidationReport(valid_count=len(records))).model_dump(
                mode="json"
            )
        sample_set_id = await _persist_sample_records(
            db,
            records,
            name=sample_set_name.strip() or f"Import {datetime.utcnow().isoformat()}",
            import_source={"type": "csv", "filename": file.filename or ""},
        )
        response = {"sample_set_id": sample_set_id, "imported_count": len(records)}
        if report is not None:
            response["validation"] = report.model_dump(mode="json")
        return response
    finally:
        await run_in_threadpool(_remove_file, temp_path)


@app.post("/api/import/jsonl/file")
async def jsonl_import_file(
    file: UploadFile = File(...),
    task_version_id: str | None = Form(None),
    validate_only: bool = Form(False),
    sample_set_name: str = Form(""),
    db: AsyncSession = Depends(get_db),
):
    temp_path = await _save_upload_to_temp(file)
    try:
        try:
            records = await run_in_threadpool(import_jsonl, temp_path)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        _dedupe_record_ids(records)
        report = await _validation_report_for_records(records, task_version_id, db)
        if validate_only:
            return (report or ImportValidationReport(valid_count=len(records))).model_dump(
                mode="json"
            )
        sample_set_id = await _persist_sample_records(
            db,
            records,
            name=sample_set_name.strip() or f"Import {datetime.utcnow().isoformat()}",
            import_source={"type": "jsonl", "filename": file.filename or ""},
        )
        response = {"sample_set_id": sample_set_id, "imported_count": len(records)}
        if report is not None:
            response["validation"] = report.model_dump(mode="json")
        return response
    finally:
        await run_in_threadpool(_remove_file, temp_path)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _get_pricing(
    db: AsyncSession,
    provider_id: str,
    model_id: str,
    pricing_profile_id: str | None,
    provider_config_id: str | None = None,
) -> PricingProfile:
    """Load a pricing profile from DB, or create a zero-cost default."""
    from app.models.pricing import PricingProfileORM

    if pricing_profile_id:
        stmt = select(PricingProfileORM).where(
            PricingProfileORM.pricing_profile_id == pricing_profile_id
        )
    elif provider_config_id:
        stmt = (
            select(PricingProfileORM)
            .where(
                PricingProfileORM.provider_config_id == provider_config_id,
                PricingProfileORM.model_id == model_id,
            )
            .order_by(PricingProfileORM.created_at.desc())
            .limit(1)
        )
    else:
        stmt = (
            select(PricingProfileORM)
            .where(
                PricingProfileORM.provider_id == provider_id,
                PricingProfileORM.model_id == model_id,
            )
            .order_by(PricingProfileORM.created_at.desc())
            .limit(1)
        )

    result = await db.execute(stmt)
    orm = result.scalar_one_or_none()

    if orm is None and provider_config_id:
        fallback_stmt = (
            select(PricingProfileORM)
            .where(
                PricingProfileORM.provider_id == provider_id,
                PricingProfileORM.model_id == model_id,
            )
            .order_by(PricingProfileORM.created_at.desc())
            .limit(1)
        )
        fallback_result = await db.execute(fallback_stmt)
        orm = fallback_result.scalar_one_or_none()

    if orm:
        return PricingProfile(
            pricing_profile_id=orm.pricing_profile_id,
            provider_id=orm.provider_id,
            provider_config_id=orm.provider_config_id,
            model_id=orm.model_id,
            currency=orm.currency,
            input_token_price=orm.input_token_price,
            output_token_price=orm.output_token_price,
            cached_input_price=orm.cached_input_price,
            batch_discount=orm.batch_discount,
            image_pricing=orm.image_pricing if isinstance(orm.image_pricing, dict) else {},
            notes=orm.notes,
        )

    # Default zero-cost profile
    return PricingProfile(
        pricing_profile_id=f"pp_default_{uuid4().hex[:8]}",
        provider_id=provider_id,
        provider_config_id=provider_config_id,
        model_id=model_id,
        currency="USD",
        input_token_price=0.0,
        output_token_price=0.0,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=True,
    )

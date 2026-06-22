"""FastAPI application entry point.

Run with:  uvicorn app.main:app --reload
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException, UploadFile, File, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

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
from app.models.prompt import PromptORM, PromptVersionORM
from app.models.result_snapshot import ResultSnapshotORM
from app.models.run import AttemptORM, RunItemORM, RunSessionORM
from app.models.sample import SampleRecordORM, SampleSetORM
from app.models.task import TaskORM
from app.schemas.common import utc_now
from app.schemas.model_config import ModelConfig, ModelParameters
from app.schemas.output_contract import OutputContract, OutputMode
from app.schemas.pricing import PricingProfile
from app.schemas.prompt import FewShotExample, ImageSlotSpec, PromptVersionData
from app.schemas.result_snapshot import ResultSnapshot as ResultSnapshotSchema
from app.schemas.sample_record import ImageRef, SampleRecord
from app.schemas.run_record import StreamEvent
from app.schemas.task import Task
from app.services.image_persist import (
    persist_request_images,
    request_image_to_image_ref,
    rewrite_image_uris,
)
from app.services.importer import ColumnMapping, import_csv, preview_csv, detect_columns
from app.services.run_executor import LabRunRequest, execute_lab_run


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
    format_instruction: str = ""
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
    pricing_profile_id: str | None = None
    image_resolution_enabled: bool = False
    image_resolution_target: int = 1024

    run_name: str = ""


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
    format_instruction: str = ""
    notes: str = ""
    image_slot_specs: list[ImageSlotSpec] = Field(default_factory=list)
    few_shot_examples: list[FewShotExample] = Field(default_factory=list)
    prompt_id: str | None = None  # if provided, creates a new version


class UpdateReviewPayload(BaseModel):
    accepted: bool | None = None
    rating: int | None = None
    labels: list[str] = Field(default_factory=list)
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


class UpdateResultSnapshotPayload(BaseModel):
    name: str | None = None
    description: str | None = None
    tags: list[str] | None = None
    notes: str | None = None
    starred: bool | None = None
    accepted: bool | None = None
    rating: int | None = None


class ApiKeyPayload(BaseModel):
    api_key: str


class CsvImportPayload(BaseModel):
    csv_path: str
    mapping: ColumnMapping
    delimiter: str = ","
    sample_set_name: str = ""


class SaveTaskPayload(BaseModel):
    name: str
    provider_config_id: str | None = None
    model_id: str
    model_parameters: ModelParameters = Field(default_factory=ModelParameters)
    system_prompt: str = ""
    user_prompt: str = ""
    format_instruction: str = ""
    output_contract: OutputContract = Field(default_factory=OutputContract)
    pricing_profile_id: str | None = None
    image_resolution_enabled: bool = False
    image_resolution_target: int = 1024
    sample_set_id: str | None = None
    notes: str = ""


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
        format_instruction=payload.format_instruction,
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
# Tasks
# ---------------------------------------------------------------------------

def _task_to_schema(row: TaskORM) -> Task:
    return Task(
        task_id=row.task_id,
        name=row.name,
        provider_config_id=row.provider_config_id,
        model_id=row.model_id,
        model_parameters=ModelParameters(**(row.model_parameters or {})),
        system_prompt=row.system_prompt,
        user_prompt=row.user_prompt,
        format_instruction=row.format_instruction,
        output_contract=OutputContract(**(row.output_contract or {})),
        pricing_profile_id=row.pricing_profile_id,
        image_resolution_enabled=row.image_resolution_enabled,
        image_resolution_target=row.image_resolution_target,
        sample_set_id=row.sample_set_id,
        notes=row.notes,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _apply_task_payload(row: TaskORM, payload: SaveTaskPayload) -> None:
    row.name = payload.name
    row.provider_config_id = payload.provider_config_id
    row.model_id = payload.model_id
    row.model_parameters = payload.model_parameters.model_dump(mode="json", exclude_none=True)
    row.system_prompt = payload.system_prompt
    row.user_prompt = payload.user_prompt
    row.format_instruction = payload.format_instruction
    row.output_contract = payload.output_contract.model_dump(mode="json", exclude_none=True)
    row.pricing_profile_id = payload.pricing_profile_id
    row.image_resolution_enabled = payload.image_resolution_enabled
    row.image_resolution_target = payload.image_resolution_target
    row.sample_set_id = payload.sample_set_id
    row.notes = payload.notes
    row.updated_at = utc_now().isoformat()


@app.get("/api/tasks")
async def list_tasks(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(TaskORM).order_by(TaskORM.updated_at.desc()))
    return [_task_to_schema(row).model_dump(mode="json") for row in result.scalars().all()]


@app.post("/api/tasks")
async def create_task(payload: SaveTaskPayload, db: AsyncSession = Depends(get_db)):
    row = TaskORM(task_id=f"task_{uuid4().hex[:12]}", name=payload.name, model_id=payload.model_id)
    _apply_task_payload(row, payload)
    db.add(row)
    await db.commit()
    return _task_to_schema(row).model_dump(mode="json")


@app.get("/api/tasks/{task_id}")
async def get_task(task_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(TaskORM).where(TaskORM.task_id == task_id))
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "Task not found")
    return _task_to_schema(row).model_dump(mode="json")


@app.put("/api/tasks/{task_id}")
async def update_task(task_id: str, payload: SaveTaskPayload, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(TaskORM).where(TaskORM.task_id == task_id))
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "Task not found")
    _apply_task_payload(row, payload)
    await db.commit()
    return _task_to_schema(row).model_dump(mode="json")


@app.delete("/api/tasks/{task_id}")
async def delete_task(task_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(TaskORM).where(TaskORM.task_id == task_id))
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(404, "Task not found")
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
    provider_id = (run_item.provider_id if run_item else None) or _dict_get(
        item_model_snapshot, "provider_id"
    ) or _dict_get(session_model_snapshot, "provider_id")
    model_id = (run_item.model_id if run_item else None) or _dict_get(
        item_model_snapshot, "model_id"
    ) or _dict_get(session_model_snapshot, "model_id")
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

    request_snapshot = (
        run_item.internal_request_snapshot if run_item is not None else None
    ) or {}
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
    stmt = stmt.order_by(ResultSnapshotORM.created_at.desc()).limit(limit)
    result = await db.execute(stmt)
    return [
        _result_snapshot_to_schema(row).model_dump(mode="json")
        for row in result.scalars().all()
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
async def list_runs(limit: int = 50, db: AsyncSession = Depends(get_db)):
    stmt = (
        select(RunSessionORM)
        .order_by(RunSessionORM.created_at.desc())
        .limit(limit)
    )
    result = await db.execute(stmt)
    rows = result.scalars().all()
    return [
        {
            "run_id": r.run_id,
            "run_type": r.run_type,
            "name": r.name,
            "status": r.status,
            "started_at": r.started_at,
            "completed_at": r.completed_at,
            "summary": r.summary,
            "created_at": r.created_at,
        }
        for r in rows
    ]


@app.get("/api/runs/{run_id}")
async def get_run(run_id: str, db: AsyncSession = Depends(get_db)):
    stmt = select(RunSessionORM).where(RunSessionORM.run_id == run_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(404, "Run session not found")

    items_stmt = select(RunItemORM).where(RunItemORM.run_id == run_id)
    items_result = await db.execute(items_stmt)
    items = items_result.scalars().all()

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
                "model_config_snapshot": i.model_config_snapshot,
                "output_contract_snapshot": i.output_contract_snapshot,
                "pricing_snapshot": i.pricing_snapshot,
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
    return [
        {
            "sample_set_id": r.sample_set_id,
            "name": r.name,
            "description": r.description,
            "record_ids": r.record_ids,
            "metadata": r.metadata_,
            "created_at": r.created_at,
        }
        for r in result.scalars().all()
    ]


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

_VERSION_LABEL_RE = re.compile(r"^v(\d+)$")


def _prompt_version_to_dict(version: PromptVersionORM) -> dict[str, Any]:
    return {
        "prompt_version_id": version.prompt_version_id,
        "prompt_id": version.prompt_id,
        "version_label": version.version_label,
        "parent_version_id": version.parent_version_id,
        "system_prompt": version.system_prompt,
        "user_template": version.user_template,
        "format_instruction": version.format_instruction,
        "notes": version.notes,
        "image_slot_specs": version.image_slot_specs or [],
        "few_shot_examples": version.few_shot_examples or [],
        "created_at": version.created_at,
        "updated_at": version.updated_at,
    }


def _prompt_to_dict(prompt: PromptORM, versions: list[PromptVersionORM]) -> dict[str, Any]:
    latest_version = None
    if prompt.current_version_id:
        latest_version = next(
            (v for v in versions if v.prompt_version_id == prompt.current_version_id), None
        )
    if latest_version is None and versions:
        latest_version = versions[-1]

    return {
        "prompt_id": prompt.prompt_id,
        "name": prompt.name,
        "description": prompt.description,
        "current_version_id": prompt.current_version_id,
        "tags": prompt.tags,
        "latest_version": _prompt_version_to_dict(latest_version) if latest_version else None,
        "created_at": prompt.created_at,
        "updated_at": prompt.updated_at,
    }


def _version_sort_key(version: PromptVersionORM) -> tuple[int, int, str]:
    match = _VERSION_LABEL_RE.match(version.version_label or "")
    if match:
        return (0, int(match.group(1)), version.created_at)
    return (1, 0, version.created_at)


def _next_version_label(versions: list[PromptVersionORM]) -> str:
    max_version = 0
    for version in versions:
        match = _VERSION_LABEL_RE.match(version.version_label or "")
        if match:
            max_version = max(max_version, int(match.group(1)))
    return f"v{max_version + 1}" if max_version else "v1"


@app.get("/api/prompts")
async def list_prompts(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(PromptORM).order_by(PromptORM.created_at.desc()))
    prompts = []
    for r in result.scalars().all():
        vstmt = (
            select(PromptVersionORM)
            .where(PromptVersionORM.prompt_id == r.prompt_id)
            .order_by(PromptVersionORM.created_at.asc())
        )
        vresult = await db.execute(vstmt)
        versions = sorted(vresult.scalars().all(), key=_version_sort_key)
        prompts.append(_prompt_to_dict(r, versions))
    return prompts


@app.get("/api/prompts/{prompt_id}")
async def get_prompt(prompt_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(PromptORM).where(PromptORM.prompt_id == prompt_id))
    prompt = result.scalar_one_or_none()
    if prompt is None:
        raise HTTPException(404, f"Prompt '{prompt_id}' not found.")

    vresult = await db.execute(
        select(PromptVersionORM)
        .where(PromptVersionORM.prompt_id == prompt_id)
        .order_by(PromptVersionORM.created_at.asc())
    )
    versions = sorted(vresult.scalars().all(), key=_version_sort_key)
    data = _prompt_to_dict(prompt, versions)
    data["versions"] = [_prompt_version_to_dict(version) for version in versions]
    return data


@app.get("/api/prompts/{prompt_id}/versions/{version_id}")
async def get_prompt_version(
    prompt_id: str, version_id: str, db: AsyncSession = Depends(get_db)
):
    result = await db.execute(
        select(PromptVersionORM).where(
            PromptVersionORM.prompt_id == prompt_id,
            PromptVersionORM.prompt_version_id == version_id,
        )
    )
    version = result.scalar_one_or_none()
    if version is None:
        raise HTTPException(
            404, f"Prompt version '{version_id}' not found for prompt '{prompt_id}'."
        )
    return _prompt_version_to_dict(version)


@app.post("/api/prompts")
async def save_prompt(payload: SavePromptPayload, db: AsyncSession = Depends(get_db)):
    prompt_id = payload.prompt_id or f"prompt_{uuid4().hex[:12]}"
    version_id = f"pv_{uuid4().hex[:16]}"

    # Create or update prompt
    stmt = select(PromptORM).where(PromptORM.prompt_id == prompt_id)
    result = await db.execute(stmt)
    prompt = result.scalar_one_or_none()

    versions_result = await db.execute(
        select(PromptVersionORM).where(PromptVersionORM.prompt_id == prompt_id)
    )
    existing_versions = versions_result.scalars().all()

    if prompt is None:
        prompt = PromptORM(
            prompt_id=prompt_id,
            name=payload.name,
            description="",
        )
        db.add(prompt)
    else:
        prompt.name = payload.name

    # Create new version
    version = PromptVersionORM(
        prompt_version_id=version_id,
        prompt_id=prompt_id,
        version_label=_next_version_label(existing_versions),
        parent_version_id=prompt.current_version_id if prompt else None,
        system_prompt=payload.system_prompt,
        user_template=payload.user_template,
        format_instruction=payload.format_instruction,
        notes=payload.notes,
        image_slot_specs=[spec.model_dump(mode="json") for spec in payload.image_slot_specs],
        few_shot_examples=[
            _persist_few_shot_example(example, prompt_id, version_id)
            for example in payload.few_shot_examples
        ],
    )
    db.add(version)
    prompt.current_version_id = version_id
    await db.commit()

    return {
        "prompt_id": prompt_id,
        "prompt_version_id": version_id,
        "created": True,
    }


@app.delete("/api/prompts/{prompt_id}")
async def delete_prompt(prompt_id: str, db: AsyncSession = Depends(get_db)):
    """Delete a prompt and all of its versions."""
    result = await db.execute(select(PromptORM).where(PromptORM.prompt_id == prompt_id))
    prompt = result.scalar_one_or_none()
    if prompt is None:
        raise HTTPException(404, f"Prompt '{prompt_id}' not found.")

    await db.execute(
        delete(PromptVersionORM).where(PromptVersionORM.prompt_id == prompt_id)
    )
    await db.delete(prompt)
    await db.commit()

    # Clean up persisted few-shot images for this prompt.
    settings = get_settings()
    prompt_dir = settings.prompts_dir / prompt_id
    if prompt_dir.exists():
        shutil.rmtree(prompt_dir, ignore_errors=True)

    return {"deleted": True}


@app.get("/api/prompts/{prompt_id}/versions/{version_id}/images/{filename}")
async def serve_prompt_version_image(
    prompt_id: str, version_id: str, filename: str
):
    """Serve a persisted few-shot image for a prompt version."""
    from pathlib import Path
    from fastapi.responses import FileResponse

    safe_name = Path(filename).name
    settings = get_settings()
    file_path = settings.prompts_dir / prompt_id / version_id / safe_name
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(404, "File not found")
    return FileResponse(file_path)


def _persist_few_shot_example(
    example: FewShotExample,
    prompt_id: str,
    version_id: str,
) -> dict[str, Any]:
    """Persist images inside a few-shot example and convert to ImageRefs.

    The frontend may send RequestImage dicts (from a run result) in
    example.images.  We copy any local files into the prompt version's own
    directory and store lightweight ImageRefs instead.
    """
    settings = get_settings()
    version_dir = settings.prompts_dir / prompt_id / version_id
    version_dir.mkdir(parents=True, exist_ok=True)

    raw_images = example.images or []
    request_images = [img.model_dump(mode="json") if isinstance(img, BaseModel) else img for img in raw_images]
    persisted = persist_request_images(request_images, version_dir)
    served = rewrite_image_uris(persisted, f"/api/prompts/{prompt_id}/versions/{version_id}/images")
    image_refs = [request_image_to_image_ref(img) for img in served]

    data = example.model_dump(mode="json")
    data["images"] = image_refs
    return data


# ---------------------------------------------------------------------------
# Model configs
# ---------------------------------------------------------------------------

@app.get("/api/model-configs")
async def list_model_configs(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(ModelConfigORM).order_by(ModelConfigORM.created_at.desc())
    )
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
async def set_api_key(
    provider_id: str, payload: ApiKeyPayload, db: AsyncSession = Depends(get_db)
):
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

    return {
        "path": str(saved_path),
        "filename": file.filename,
        "mime_type": mime,
        "size": len(content),
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


# ---------------------------------------------------------------------------
# Provider configs (bundle adapter + base_url + api_key)
# ---------------------------------------------------------------------------

from app.models.provider_config import ProviderConfigORM as _PCORM
from app.core.security import encrypt_value as _encrypt, decrypt_value as _decrypt, mask_api_key as _mask


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


@app.post("/api/provider-configs")
async def save_provider_config(payload: SaveProviderConfigPayload, db: AsyncSession = Depends(get_db)):
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


@app.post("/api/import/csv")
async def csv_import(payload: CsvImportPayload, db: AsyncSession = Depends(get_db)):
    records = import_csv(payload.csv_path, payload.mapping, payload.delimiter)

    sample_set_id = f"ss_{uuid4().hex[:12]}"
    set_orm = SampleSetORM(
        sample_set_id=sample_set_id,
        name=payload.sample_set_name or f"Import {datetime.utcnow().isoformat()}",
        import_source={"type": "csv", "path": payload.csv_path},
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
    return {
        "sample_set_id": sample_set_id,
        "imported_count": len(records),
    }


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

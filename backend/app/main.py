"""FastAPI application entry point.

Run with:  uvicorn app.main:app --reload
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException, UploadFile, File, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import select
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
from app.models.run import RunItemORM, RunSessionORM
from app.models.sample import SampleRecordORM, SampleSetORM
from app.schemas.model_config import ModelConfig, ModelParameters
from app.schemas.output_contract import OutputContract, OutputMode
from app.schemas.pricing import PricingProfile
from app.schemas.prompt import PromptVersion, PromptVersionData
from app.schemas.sample_record import ImageRef, SampleRecord
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
    provider_id: str
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
    prompt_id: str | None = None  # if provided, creates a new version


class UpdateReviewPayload(BaseModel):
    accepted: bool | None = None
    rating: int | None = None
    labels: list[str] = Field(default_factory=list)
    notes: str = ""


class ApiKeyPayload(BaseModel):
    api_key: str


class CsvImportPayload(BaseModel):
    csv_path: str
    mapping: ColumnMapping
    delimiter: str = ","
    sample_set_name: str = ""


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
    adapter_id: str = "openai"
    api_key: str
    base_url: str | None = None


@app.post("/api/providers/models")
async def fetch_provider_models(payload: FetchModelsPayload, db: AsyncSession = Depends(get_db)):
    """Fetch the live model list from a provider's ``/v1/models`` endpoint.

    If ``api_key`` is empty, the stored key for the adapter's provider is used.
    """

    from app.adapters.registry import get_adapter, get_adapter_metadata

    adapter = get_adapter(payload.adapter_id)
    meta = get_adapter_metadata(payload.adapter_id) or {}
    requires_base_url = bool(meta.get("requires_base_url", False))

    api_key = payload.api_key
    if not api_key:
        # Fall back to stored key — use adapter_id as provider identifier
        api_key = await get_api_key(db, payload.adapter_id) or ""

    base_url = payload.base_url
    if requires_base_url and not base_url:
        raise HTTPException(
            400,
            f"Adapter '{payload.adapter_id}' requires a base_url to fetch models.",
        )

    try:
        models = await adapter.fetch_models(api_key=api_key, base_url=base_url)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(502, f"Provider model discovery failed: {exc}") from exc

    return {"models": models, "adapter_id": payload.adapter_id}


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
    pricing = await _get_pricing(db, provider_id, payload.model_id, payload.pricing_profile_id)

    run_request = LabRunRequest(
        sample=payload.sample,
        prompt=prompt_data,
        model_config=model_config,
        output_contract=payload.output_contract,
        pricing=pricing,
        api_base_url=api_base_url,
        run_name=payload.run_name,
        provider_config_id=payload.provider_config_id,
    )

    session = await execute_lab_run(db, run_request)
    await db.commit()
    return session.model_dump(mode="json")


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------

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

@app.get("/api/prompts")
async def list_prompts(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(PromptORM).order_by(PromptORM.created_at.desc()))
    prompts = []
    for r in result.scalars().all():
        # Get latest version
        vstmt = (
            select(PromptVersionORM)
            .where(PromptVersionORM.prompt_id == r.prompt_id)
            .order_by(PromptVersionORM.created_at.desc())
            .limit(1)
        )
        vresult = await db.execute(vstmt)
        version = vresult.scalar_one_or_none()
        prompts.append(
            {
                "prompt_id": r.prompt_id,
                "name": r.name,
                "description": r.description,
                "current_version_id": r.current_version_id,
                "tags": r.tags,
                "latest_version": {
                    "prompt_version_id": version.prompt_version_id,
                    "version_label": version.version_label,
                    "system_prompt": version.system_prompt,
                    "user_template": version.user_template,
                    "format_instruction": version.format_instruction,
                    "notes": version.notes,
                }
                if version
                else None,
                "created_at": r.created_at,
            }
        )
    return prompts


@app.post("/api/prompts")
async def save_prompt(payload: SavePromptPayload, db: AsyncSession = Depends(get_db)):
    prompt_id = payload.prompt_id or f"prompt_{uuid4().hex[:12]}"
    version_id = f"pv_{uuid4().hex[:16]}"

    # Create or update prompt
    stmt = select(PromptORM).where(PromptORM.prompt_id == prompt_id)
    result = await db.execute(stmt)
    prompt = result.scalar_one_or_none()

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
        version_label=f"v{uuid4().hex[:4]}",
        system_prompt=payload.system_prompt,
        user_template=payload.user_template,
        format_instruction=payload.format_instruction,
        notes=payload.notes,
    )
    db.add(version)
    prompt.current_version_id = version_id
    await db.commit()

    return {
        "prompt_id": prompt_id,
        "prompt_version_id": version_id,
        "created": True,
    }


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
async def list_pricing(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(PricingProfileORM).order_by(PricingProfileORM.created_at.desc())
    )
    return [
        {
            "pricing_profile_id": r.pricing_profile_id,
            "provider_id": r.provider_id,
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
    profile_id = f"pp_{uuid4().hex[:12]}"
    orm = PricingProfileORM(
        pricing_profile_id=profile_id,
        provider_id=payload.provider_id,
        model_id=payload.model_id,
        currency=payload.currency,
        input_token_price=payload.input_token_price,
        output_token_price=payload.output_token_price,
        cached_input_price=payload.cached_input_price,
        batch_discount=payload.batch_discount,
        image_pricing=payload.image_pricing,
        notes=payload.notes,
    )
    db.add(orm)
    await db.commit()
    return {"pricing_profile_id": profile_id, "created": True}


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
) -> PricingProfile:
    """Load a pricing profile from DB, or create a zero-cost default."""
    from app.models.pricing import PricingProfileORM

    if pricing_profile_id:
        stmt = select(PricingProfileORM).where(
            PricingProfileORM.pricing_profile_id == pricing_profile_id
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

    if orm:
        return PricingProfile(
            pricing_profile_id=orm.pricing_profile_id,
            provider_id=orm.provider_id,
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

"""Run Executor – orchestrates the full request → response → persist pipeline.

This is the core integration layer that ties together:
  request_builder → adapter → parser_engine → cost_engine → database

Flow::

    build_internal_request(...)
        → adapter.execute(...)
        → parse_response(...)
        → calculate_cost(...)
        → persist RunSession + RunItem + Attempt
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from datetime import datetime
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.registry import get_adapter
from app.core.security import get_api_key
from app.models.run import AttemptORM, RunItemORM, RunSessionORM
from app.models.sample import SampleRecordORM
from app.schemas.common import (
    AttemptStatus,
    ErrorType,
    RunItemType,
    RunSessionStatus,
    RunType,
    utc_now,
)
from app.schemas.internal_request import ImagePreprocessConfig, InternalRequest
from app.schemas.model_config import ModelConfig, ModelConfigSnapshot
from app.schemas.output_contract import OutputContract
from app.schemas.pricing import PricingProfile, PricingSnapshot
from app.schemas.prompt import (
    ImageSlotSpec,
    PromptSnapshot,
    PromptVersion,
    PromptVersionData,
    VariableSpec,
)
from app.schemas.run_record import (
    AdapterInfo,
    Attempt,
    ConfigSnapshot,
    ParsedResponse,
    Review,
    RunItem,
    RunSession,
    RunSource,
    RunSummary,
    StreamEvent,
    Usage,
)
from app.schemas.sample_record import SampleRecord
from app.services.cost_engine import calculate_cost
from app.services.parser_engine import parse_response
from app.services.request_builder import build_internal_request


# ---------------------------------------------------------------------------
# Lab run request DTO (used by the API layer)
# ---------------------------------------------------------------------------

class LabRunRequest:
    """Input bundle for a single Lab run."""

    def __init__(
        self,
        sample: SampleRecord,
        prompt: PromptVersion | PromptVersionData,
        model_config: ModelConfig,
        output_contract: OutputContract,
        pricing: PricingProfile | PricingSnapshot,
        api_base_url: str | None = None,
        run_name: str = "",
        provider_config_id: str | None = None,
        image_resolution_enabled: bool = False,
        image_resolution_target: int = 1024,
        image_slot_specs: list[ImageSlotSpec] | None = None,
        variable_specs: list[VariableSpec] | None = None,
    ):
        self.sample = sample
        self.prompt = prompt
        self.model_config = model_config
        self.output_contract = output_contract
        self.pricing = pricing
        self.api_base_url = api_base_url
        self.run_name = run_name
        self.provider_config_id = provider_config_id
        self.image_resolution_enabled = image_resolution_enabled
        self.image_resolution_target = image_resolution_target
        self.image_slot_specs = image_slot_specs or []
        self.variable_specs = variable_specs or []


# ---------------------------------------------------------------------------
# Main executor
# ---------------------------------------------------------------------------

async def execute_lab_run(
    db: AsyncSession,
    request: LabRunRequest,
    stream_callback: Callable[[StreamEvent], Awaitable[None]] | None = None,
) -> RunSession:
    """Execute a single-sample Lab run end-to-end.

    Returns the persisted :class:`RunSession` (with one :class:`RunItem`).
    """

    run_id = f"run_{uuid4().hex[:16]}"
    run_item_id = f"ritem_{uuid4().hex[:16]}"
    attempt_id = f"attempt_{uuid4().hex[:16]}"
    now = utc_now()

    # 1. Build the Internal Request -------------------------------------------
    preprocess_config = None
    if request.image_resolution_enabled:
        preprocess_config = ImagePreprocessConfig(
            mode="limit_total_pixels",
            target_pixels=request.image_resolution_target ** 2,
        )

    internal_request = build_internal_request(
        sample=request.sample,
        prompt_version=request.prompt,
        model_config=request.model_config,
        output_contract=request.output_contract,
        pricing=request.pricing,
        preprocess_config=preprocess_config,
    )

    # 2. Prepare snapshots for the Run Session --------------------------------
    prompt_snapshot = _make_prompt_snapshot(
        request.prompt,
        image_slot_specs=request.image_slot_specs,
        variable_specs=request.variable_specs,
    )
    model_snapshot = ModelConfigSnapshot(
        model_config_id=request.model_config.model_config_id,
        provider_id=request.model_config.provider_id,
        model_id=request.model_config.model_id,
        adapter_id=request.model_config.adapter_id,
        parameters=request.model_config.parameters,
        provider_options=request.model_config.provider_options,
    )
    pricing_snapshot = internal_request.cost_context.pricing_snapshot

    # 3. Create the Run Session row -------------------------------------------
    session_orm = RunSessionORM(
        run_id=run_id,
        run_type=RunType.LAB.value,
        name=request.run_name or f"Lab: {request.sample.sample_id}",
        status=RunSessionStatus.RUNNING.value,
        started_at=now.isoformat(),
        source=RunSource(
            mode="lab", sample_ids=[request.sample.sample_id]
        ).model_dump(mode="json"),
        config_snapshot=ConfigSnapshot(
            prompt_version=prompt_snapshot,
            model_config_snapshot=model_snapshot,
            output_contract=request.output_contract,
            pricing_profile=pricing_snapshot,
        ).model_dump(mode="json"),
        summary=RunSummary(total_items=1).model_dump(mode="json"),
    )
    db.add(session_orm)

    # 4. Create the Run Item row (status=running) -----------------------------
    item_orm = RunItemORM(
        run_item_id=run_item_id,
        run_id=run_id,
        sample_id=request.sample.sample_id,
        status=RunItemType.RUNNING.value,
        started_at=now.isoformat(),
        internal_request_snapshot=internal_request.model_dump(mode="json"),
        prompt_snapshot=prompt_snapshot.model_dump(mode="json"),
        model_config_snapshot=model_snapshot.model_dump(mode="json"),
        output_contract_snapshot=request.output_contract.model_dump(mode="json"),
        pricing_snapshot=pricing_snapshot.model_dump(mode="json") if pricing_snapshot else None,
        provider_id=request.model_config.provider_id,
        model_id=request.model_config.model_id,
    )
    db.add(item_orm)
    await db.flush()

    # 5. Execute the adapter call ---------------------------------------------
    adapter = get_adapter(request.model_config.adapter_id)

    # Resolve API key: prefer provider_config_id, fall back to provider_id
    api_key = None
    if request.provider_config_id:
        from app.models.provider_config import ProviderConfigORM
        from app.core.security import decrypt_value as _decrypt

        pc_stmt = select(ProviderConfigORM).where(
            ProviderConfigORM.provider_config_id == request.provider_config_id
        )
        pc_result = await db.execute(pc_stmt)
        pc_orm = pc_result.scalar_one_or_none()
        if pc_orm and pc_orm.api_key_encrypted:
            api_key = _decrypt(pc_orm.api_key_encrypted)

    if not api_key:
        api_key = await get_api_key(db, request.model_config.provider_id)

    if not api_key:
        # No key resolved (e.g. local no-auth endpoints like LM Studio/Ollama).
        # Allow the request to proceed; the remote will return 401 if a key is
        # actually required, which normalize_error surfaces as AUTH_ERROR.
        api_key = ""

    # Commit the "running" session/item before the network call. SQLite (even in
    # WAL) allows only one writer at a time, so holding the uncommitted write
    # transaction across the slow adapter call would serialize concurrent batch
    # items. Subsequent writes below autobegin a fresh transaction.
    await db.commit()
    should_stream = request.model_config.parameters.stream is True
    if should_stream:
        async def forward_stream_event(event: StreamEvent) -> None:
            if stream_callback is not None and event.event != "done":
                await stream_callback(event)

        result = await adapter.execute_stream(
            request=internal_request,
            api_key=api_key,
            base_url=request.api_base_url,
            timeout=internal_request.runtime.timeout_seconds,
            on_event=forward_stream_event,
        )
    else:
        result = await adapter.execute(
            request=internal_request,
            api_key=api_key,
            base_url=request.api_base_url,
            timeout=internal_request.runtime.timeout_seconds,
        )

    # 6. Parse the response --------------------------------------------------
    raw_text = ""
    if result.normalized_response:
        raw_text = result.normalized_response.text or ""

    parsed = parse_response(raw_text, request.output_contract)
    if result.normalized_response:
        parsed.reasoning_text = result.normalized_response.reasoning_text

    # 7. Calculate cost -------------------------------------------------------
    usage = result.usage or Usage(
        image_count=len(internal_request.images), provider_reported=False, estimated=True
    )
    cost = calculate_cost(usage, pricing_snapshot) if pricing_snapshot else None

    # 8. Persist the Attempt --------------------------------------------------
    attempt_orm = AttemptORM(
        attempt_id=attempt_id,
        run_item_id=run_item_id,
        attempt_index=0,
        status=result.status.value,
        started_at=now.isoformat(),
        completed_at=utc_now().isoformat(),
        provider_id=request.model_config.provider_id,
        adapter_id=request.model_config.adapter_id,
        model_id=request.model_config.model_id,
        provider_request_snapshot=result.provider_request_snapshot,
        provider_response_raw=result.provider_response_raw,
        normalized_response=result.normalized_response.model_dump(mode="json")
        if result.normalized_response
        else None,
        usage=usage.model_dump(mode="json"),
        error=result.error.model_dump(mode="json") if result.error else None,
        latency_ms=result.latency_ms,
    )
    db.add(attempt_orm)

    # 9. Update the Run Item --------------------------------------------------
    item_orm.status = (
        RunItemType.SUCCEEDED.value
        if result.status == AttemptStatus.SUCCEEDED
        else RunItemType.FAILED.value
    )
    item_orm.completed_at = utc_now().isoformat()
    item_orm.final_attempt_id = attempt_id
    item_orm.response = parsed.model_dump(mode="json")
    item_orm.usage = usage.model_dump(mode="json")
    item_orm.latency_ms = result.latency_ms
    if cost:
        item_orm.cost = cost.model_dump(mode="json")
        item_orm.estimated_cost = cost.estimated_cost
    if result.error:
        item_orm.error = result.error.model_dump(mode="json")

    # 10. Update the Run Session summary -------------------------------------
    _update_session_summary(session_orm, item_orm)

    await db.flush()
    return _to_session(session_orm)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_prompt_snapshot(
    prompt: PromptVersion | PromptVersionData,
    *,
    image_slot_specs: list[ImageSlotSpec] | None = None,
    variable_specs: list[VariableSpec] | None = None,
) -> PromptSnapshot:
    image_slot_specs = image_slot_specs or []
    variable_specs = variable_specs or []
    if isinstance(prompt, PromptVersion):
        return PromptSnapshot(
            prompt_id=prompt.prompt_id,
            prompt_version_id=prompt.prompt_version_id,
            system_prompt=prompt.system_prompt,
            user_template=prompt.user_template,
            notes=prompt.notes,
            image_slot_specs=image_slot_specs,
            variable_specs=variable_specs,
        )
    return PromptSnapshot(
        system_prompt=prompt.system_prompt,
        user_template=prompt.user_template,
        notes=prompt.notes,
        image_slot_specs=image_slot_specs,
        variable_specs=variable_specs,
    )


async def _fail_item(
    db: AsyncSession,
    item_orm: RunItemORM,
    session_orm: RunSessionORM,
    attempt_id: str,
    error_type: ErrorType,
    message: str,
    internal_request: InternalRequest,
    model_config: ModelConfig,
) -> None:
    from app.schemas.common import NormalizedError

    error = NormalizedError(type=error_type, message=message, retryable=False)
    now = utc_now()
    attempt_orm = AttemptORM(
        attempt_id=attempt_id,
        run_item_id=item_orm.run_item_id,
        attempt_index=0,
        status=AttemptStatus.FAILED.value,
        started_at=now.isoformat(),
        completed_at=now.isoformat(),
        provider_id=model_config.provider_id,
        adapter_id=model_config.adapter_id,
        model_id=model_config.model_id,
        error=error.model_dump(mode="json"),
    )
    db.add(attempt_orm)

    item_orm.status = RunItemType.FAILED.value
    item_orm.completed_at = now.isoformat()
    item_orm.final_attempt_id = attempt_id
    item_orm.error = error.model_dump(mode="json")

    _update_session_summary(session_orm, item_orm)
    await db.flush()


def _update_session_summary(session_orm: RunSessionORM, item_orm: RunItemORM) -> None:
    summary = RunSummary(**session_orm.summary)
    summary.total_items = 1
    summary.total_attempts = max(summary.total_attempts, 1)
    if item_orm.status == RunItemType.SUCCEEDED.value:
        summary.succeeded_items = 1
    elif item_orm.status == RunItemType.FAILED.value:
        summary.failed_items = 1
    summary.total_cost_estimated = item_orm.estimated_cost

    usage_data = item_orm.usage or {}
    summary.total_input_tokens = usage_data.get("input_tokens", 0) or 0
    summary.total_output_tokens = usage_data.get("output_tokens", 0) or 0
    summary.total_image_count = usage_data.get("image_count", 0) or 0

    # Update latency summary
    item_latency = item_orm.latency_ms or 0
    summary.total_latency_ms = item_latency
    summary.avg_latency_ms = float(item_latency)

    session_orm.summary = summary.model_dump(mode="json")
    session_orm.status = (
        RunSessionStatus.COMPLETED.value
        if item_orm.status == RunItemType.SUCCEEDED.value
        else RunSessionStatus.COMPLETED_WITH_ERRORS.value
    )
    session_orm.completed_at = utc_now().isoformat()


def _to_session(session_orm: RunSessionORM) -> RunSession:
    """Convert a RunSessionORM to a RunSession Pydantic model."""
    return RunSession(
        run_id=session_orm.run_id,
        run_type=RunType(session_orm.run_type),
        name=session_orm.name,
        status=RunSessionStatus(session_orm.status),
        started_at=_parse_dt(session_orm.started_at),
        completed_at=_parse_dt(session_orm.completed_at),
        source=RunSource(**session_orm.source),
        config_snapshot=ConfigSnapshot(**session_orm.config_snapshot),
        summary=RunSummary(**session_orm.summary),
        notes=session_orm.notes,
    )


def _parse_dt(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso)
    except ValueError:
        return None

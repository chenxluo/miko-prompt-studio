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

from collections.abc import Awaitable, Callable
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.adapters.registry import get_adapter
from app.config import get_settings
from app.core.security import get_api_key
from app.models.run import AttemptORM, RunItemORM, RunSessionORM
from app.schemas.common import (
    AttemptStatus,
    ErrorType,
    ImageTransportKind,
    NormalizedError,
    RunItemType,
    RunSessionStatus,
    RunType,
    UrlImageTransport,
    utc_now,
)
from app.schemas.internal_request import (
    ImagePreprocessConfig,
    InternalRequest,
    RequestImage,
)
from app.schemas.model_config import ModelConfig, ModelConfigSnapshot, ProviderCapability
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
    ConfigSnapshot,
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
from app.services.snapshot_scrub import rewrite_inline_image_uris, scrub_image_bytes

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
        url_image_transport: UrlImageTransport = UrlImageTransport.AUTO,
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
        self.url_image_transport = url_image_transport


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
            target_pixels=request.image_resolution_target**2,
        )

    internal_request = build_internal_request(
        sample=request.sample,
        prompt_version=request.prompt,
        model_config=request.model_config,
        output_contract=request.output_contract,
        pricing=request.pricing,
        preprocess_config=preprocess_config,
        image_slot_specs=request.image_slot_specs,
        url_image_transport=request.url_image_transport,
    )

    # Resolve the adapter lazily — only when a path-less non-data URI is
    # actually present, so fake/local-only adapters that don't implement
    # get_capability keep working unchanged.
    adapter = None
    capability: ProviderCapability | None = None
    capability_error: str | None = None
    if any(_is_url_only_image(img) for img in internal_request.images):
        try:
            adapter = get_adapter(request.model_config.adapter_id)
            capability = adapter.get_capability(request.model_config.model_id)
        except Exception as exc:
            capability_error = (
                f"Adapter {request.model_config.adapter_id!r} could not "
                f"provide a capability descriptor: {exc}"
            )

    prepare_error = await _prepare_request_images(
        internal_request=internal_request,
        preprocess_active=request.image_resolution_enabled,
        uploads_dir=get_settings().uploads_dir,
        capability=capability,
        capability_error=capability_error,
    )
    if prepare_error is not None:
        return await _fail_run(
            db=db,
            run_id=run_id,
            run_item_id=run_item_id,
            attempt_id=attempt_id,
            internal_request=internal_request,
            sample_id=request.sample.sample_id,
            run_name=request.run_name,
            prompt_version=request.prompt,
            image_slot_specs=request.image_slot_specs,
            variable_specs=request.variable_specs,
            model_config=request.model_config,
            output_contract=request.output_contract,
            error=prepare_error,
        )
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
        source=RunSource(mode="lab", sample_ids=[request.sample.sample_id]).model_dump(mode="json"),
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
        internal_request_snapshot=rewrite_inline_image_uris(
            internal_request.model_dump(mode="json"), run_item_id
        ),
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
    # Resolve the adapter here even if no URL images were present (so we
    # have an instance to dispatch to). Capability was queried earlier only
    # when actually needed.
    if adapter is None:
        adapter = get_adapter(request.model_config.adapter_id)
    # Resolve API key: prefer provider_config_id, fall back to provider_id
    api_key = None
    if request.provider_config_id:
        from app.core.security import decrypt_value as _decrypt
        from app.models.provider_config import ProviderConfigORM

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
    if adapter is None:
        # No URL images ⇒ capability was never queried; resolve the adapter
        # now so we can still send the request. Existing fake/local-only
        # adapters work fine from this point on.
        adapter = get_adapter(request.model_config.adapter_id)
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
        provider_request_snapshot=scrub_image_bytes(result.provider_request_snapshot),
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
    elif result.status == AttemptStatus.FAILED:
        # Adapters can report FAILED with no structured error (e.g. empty choices).
        # Always persist a fallback so the failure is explainable in the UI/API.
        item_orm.error = {
            "type": ErrorType.EMPTY_RESPONSE.value,
            "message": (
                f"Run item failed (status={result.status.value}) but adapter returned no "
                "structured error. Likely empty/blank model response. See usage for clues."
            ),
            "retryable": False,
            "provider_error_code": None,
            "raw_error": None,
        }

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
    model_config: ModelConfig,
) -> None:

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


def _is_url_only_image(image: RequestImage) -> bool:
    """True for images that arrived via path-less, non-``data:`` URI."""
    uri = (image.source_uri or "").strip()
    return image.path is None and bool(uri) and not uri.startswith("data:")


# ---------------------------------------------------------------------------
# URL image transport preparation
# ---------------------------------------------------------------------------


def _split_request_images(
    internal_request: InternalRequest,
) -> tuple[list[RequestImage], list[RequestImage], list[RequestImage]]:
    """Split request images into (url_only, local, data_uri) buckets.

    The buckets drive the transport decision: data: URIs are always inline
    (they ARE inline); local paths are always inline; any URL-shaped source
    (http(s), gs://, ftp://, …) is a candidate for direct transport and is
    gated by the provider capability. The scheme check happens later.
    """
    url_only: list[RequestImage] = []
    local: list[RequestImage] = []
    data_uri: list[RequestImage] = []
    for image in internal_request.images:
        uri = (image.source_uri or "").strip()
        if image.path is None and uri.startswith("data:"):
            data_uri.append(image)
        elif image.path is None and uri:
            url_only.append(image)
        else:
            local.append(image)
    return url_only, local, data_uri


def _scheme_matches(scheme: str, allowed: list[str]) -> bool:
    """True if bare ``scheme`` (lowercased) is in the capability allow-list.

    ``allowed`` entries are bare lowercase scheme names (``"http"``,
    ``"https"``, ``"gs"``) — the shared contract canonicalized format.
    """
    target = scheme.lower()
    return any(item.strip().lower().rstrip(":").rstrip("/") == target for item in allowed)


async def _prepare_request_images(
    *,
    internal_request: InternalRequest,
    preprocess_active: bool,
    uploads_dir: Path,
    capability: ProviderCapability | None,
    capability_error: str | None = None,
) -> NormalizedError | None:
    """Decide and apply per-image transport for the InternalRequest.

    The function mutates each :class:`RequestImage`'s ``resolved`` so the
    effective transport (direct/inline/provider-uri) is recorded next to the
    user-entered ``source_uri``. ``InternalRequest.url_image_transport`` is
    NEVER overwritten — the user-selected policy (``auto`` stays ``auto``)
    is preserved in snapshots so reviewers can see what was asked for.

    Guards (all non-retryable ``UNSUPPORTED_CAPABILITY``):

      * Explicit ``direct`` + preprocessing → reject.
      * Explicit ``direct`` + unsupported scheme → reject.
      * Explicit ``direct`` + exceeds ``max_direct_images`` → reject.
      * Explicit ``inline`` + provider without inline support → reject.

    Per-image resolution:

      * ``auto`` + preprocessing → inline (preprocess applied).
      * ``auto`` + supported scheme → direct_url / provider_uri (no fetch).
      * ``auto`` + unsupported scheme + inline supported → inline.
      * ``auto`` + max_direct_images exceeded → inline (all remote URLs OK).

    No URL-only image ⇒ no work, no capability lookup, no error.
    """
    from urllib.parse import urlparse

    from app.schemas.sample_record import ImageRef
    from app.services.image_preprocess import preprocess_image
    from app.services.remote_image import materialize_url_image

    url_only, _local, _data = _split_request_images(internal_request)
    if not url_only:
        return None

    # Capability is only consulted when a path-less non-data URI exists.
    # Fake/local-only adapters may legitimately omit one — surface a
    # non-retryable error rather than crashing.
    if capability is None:
        return NormalizedError(
            type=ErrorType.UNSUPPORTED_CAPABILITY,
            message=capability_error
            or (
                "Adapter did not provide a capability descriptor; URL image transport requires one."
            ),
            retryable=False,
        )
    policy = internal_request.url_image_transport
    direct_schemes = list(capability.direct_image_uri_schemes or [])
    inline_supported = bool(capability.supports_inline_image_data)
    max_direct = capability.max_direct_images

    # --- Pre-validate explicit policies (DIRECT / INLINE) ------------------
    if policy == UrlImageTransport.DIRECT and preprocess_active:
        return NormalizedError(
            type=ErrorType.UNSUPPORTED_CAPABILITY,
            message=(
                "url_image_transport='direct' is incompatible with image "
                "preprocessing (lab 'Image Resolution' is on). Turn the "
                "resolution off or switch the policy to 'inline'/'auto'."
            ),
            retryable=False,
        )
    if policy == UrlImageTransport.INLINE and not inline_supported and url_only:
        return NormalizedError(
            type=ErrorType.UNSUPPORTED_CAPABILITY,
            message=(
                f"Provider {capability.provider_id!r} does not support inline "
                "image data; url_image_transport='inline' cannot materialize "
                "remote URLs."
            ),
            retryable=False,
        )
    # Count only URL images whose scheme the capability accepts as direct
    # — unsupported-scheme URLs do not count toward max_direct so AUTO can
    # still fall back to inline for them deterministically.
    direct_eligible = [
        img
        for img in url_only
        if _scheme_matches(
            (urlparse(img.source_uri or "").scheme or "").lower(),
            direct_schemes,
        )
    ]
    if (
        policy == UrlImageTransport.DIRECT
        and max_direct is not None
        and len(direct_eligible) > max_direct
    ):
        return NormalizedError(
            type=ErrorType.UNSUPPORTED_CAPABILITY,
            message=(
                f"Provider {capability.provider_id!r} accepts at most "
                f"{max_direct} direct URL images per request, got "
                f"{len(direct_eligible)} eligible."
            ),
            retryable=False,
        )

    new_images: list[RequestImage] = []
    for image in internal_request.images:
        if image not in url_only:
            new_images.append(image)
            continue

        parsed = urlparse(image.source_uri or "")
        scheme = (parsed.scheme or "").lower()
        scheme_ok = _scheme_matches(scheme, direct_schemes)

        if policy == UrlImageTransport.DIRECT:
            # Explicit direct: must validate and send as-is. Never fetch.
            if not scheme_ok:
                return NormalizedError(
                    type=ErrorType.UNSUPPORTED_CAPABILITY,
                    message=(
                        f"Provider {capability.provider_id!r} does not accept "
                        f"direct URLs with scheme {scheme!r}; supported: "
                        f"{direct_schemes or 'none'}."
                    ),
                    retryable=False,
                )
            # Update resolved metadata so reviewers see why this went direct.
            resolved = (
                image.resolved.model_copy(
                    update={
                        "transport": _kind_for_direct_scheme(scheme),
                        "transport_reason": "explicit_direct",
                    }
                )
                if image.resolved is not None
                else image.resolved
            )
            new_images.append(image.model_copy(update={"resolved": resolved}))
            continue

        if policy == UrlImageTransport.INLINE:
            if not inline_supported:
                return NormalizedError(
                    type=ErrorType.UNSUPPORTED_CAPABILITY,
                    message=(
                        f"Provider {capability.provider_id!r} does not support inline image data."
                    ),
                    retryable=False,
                )
            inline_reason = "explicit_inline"

        else:  # AUTO
            if (
                preprocess_active
                or not scheme_ok
                or (max_direct is not None and len(direct_eligible) > max_direct)
            ):
                # Force inline path.
                if not inline_supported:
                    return NormalizedError(
                        type=ErrorType.UNSUPPORTED_CAPABILITY,
                        message=(
                            f"Provider {capability.provider_id!r} cannot deliver "
                            f"scheme {scheme!r}: not in the direct allow-list "
                            "and inline image data is not supported."
                        ),
                        retryable=False,
                    )
                inline_reason = (
                    "preprocessed_inline" if preprocess_active else "auto_inline_fallback"
                )
            else:
                # Supported scheme, not over the cap → direct, no fetch.
                resolved = (
                    image.resolved.model_copy(
                        update={
                            "transport": _kind_for_direct_scheme(scheme),
                            "transport_reason": "auto_direct_supported",
                        }
                    )
                    if image.resolved is not None
                    else image.resolved
                )
                new_images.append(image.model_copy(update={"resolved": resolved}))
                continue

        # --- Inline path: download + apply preprocess ----------------------
        try:
            materialized = await materialize_url_image(image.source_uri, uploads_dir)
        except Exception as exc:
            return NormalizedError(
                type=ErrorType.PROVIDER_ERROR,
                message=f"Failed to materialize image URL: {exc}",
                retryable=False,
            )
        # Build a synthetic ImageRef that points at the local file so the
        # existing preprocess_image branch runs unchanged.
        source_uri = image.source_uri
        preprocessed = preprocess_image(
            ImageRef(
                image_id=image.source_image_id,
                role=image.role,
                path=materialized["path"],
                uri=None,
                mime_type=image.mime_type or materialized["mime_type"],
                order=image.order,
            ),
            image.preprocess,
            uploads_dir,
        )
        # Restore source_uri + force transport=INLINE_DATA so reviewers can
        # still see what the user entered.
        restored = preprocessed.model_copy(
            update={
                "source_uri": source_uri,
                "resolved": preprocessed.resolved.model_copy(
                    update={
                        "transport": ImageTransportKind.INLINE_DATA,
                        "transport_reason": inline_reason,
                    }
                ),
            }
        )
        new_images.append(restored)

    internal_request.images = new_images
    return None


def _kind_for_direct_scheme(scheme: str) -> ImageTransportKind:
    """Provider-native URI schemes (e.g. ``gs``) record as ``provider_uri``;
    everything else records as ``direct_url``."""
    return ImageTransportKind.PROVIDER_URI if scheme == "gs" else ImageTransportKind.DIRECT_URL


async def _fail_run(
    *,
    db: AsyncSession,
    run_id: str,
    run_item_id: str,
    attempt_id: str,
    internal_request: InternalRequest | None,
    sample_id: str,
    run_name: str,
    prompt_version: PromptVersion | PromptVersionData,
    image_slot_specs: list[ImageSlotSpec],
    variable_specs: list[VariableSpec],
    model_config: ModelConfig,
    output_contract: OutputContract,
    error: NormalizedError,
) -> RunSession:
    """Persist a run that failed before any adapter call (transport/capability
    guards). Mirrors the post-executor tail of :func:`execute_lab_run` so the
    failure surfaces in the same shape as a real attempt failure. When
    ``internal_request`` is provided its snapshot (and the user-selected
    ``url_image_transport``) is persisted so reviewers can see exactly what
    was attempted."""
    now = utc_now()
    prompt_snapshot = _make_prompt_snapshot(
        prompt_version,
        image_slot_specs=image_slot_specs,
        variable_specs=variable_specs,
    )
    model_snapshot = ModelConfigSnapshot(
        model_config_id=model_config.model_config_id,
        provider_id=model_config.provider_id,
        model_id=model_config.model_id,
        adapter_id=model_config.adapter_id,
        parameters=model_config.parameters,
        provider_options=model_config.provider_options,
    )
    session_orm = RunSessionORM(
        run_id=run_id,
        run_type=RunType.LAB.value,
        name=run_name or f"Lab: {sample_id}",
        status=RunSessionStatus.RUNNING.value,
        started_at=now.isoformat(),
        source=RunSource(mode="lab", sample_ids=[sample_id]).model_dump(mode="json"),
        config_snapshot=ConfigSnapshot(
            prompt_version=prompt_snapshot,
            model_config_snapshot=model_snapshot,
            output_contract=output_contract,
        ).model_dump(mode="json"),
        summary=RunSummary(total_items=1).model_dump(mode="json"),
    )
    db.add(session_orm)
    item_orm = RunItemORM(
        run_item_id=run_item_id,
        run_id=run_id,
        sample_id=sample_id,
        status=RunItemType.RUNNING.value,
        started_at=now.isoformat(),
        internal_request_snapshot=(
            rewrite_inline_image_uris(
                internal_request.model_dump(mode="json"), run_item_id
            )
            if internal_request is not None
            else None
        ),
        prompt_snapshot=prompt_snapshot.model_dump(mode="json"),
        model_config_snapshot=model_snapshot.model_dump(mode="json"),
        output_contract_snapshot=output_contract.model_dump(mode="json"),
        provider_id=model_config.provider_id,
        model_id=model_config.model_id,
    )
    db.add(item_orm)
    await db.flush()
    await _fail_item(
        db=db,
        item_orm=item_orm,
        session_orm=session_orm,
        attempt_id=attempt_id,
        error_type=error.type,
        message=error.message,
        model_config=model_config,
    )
    await db.commit()
    return _to_session(session_orm)


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
        pipeline_id=session_orm.pipeline_id,
        pipeline_step=session_orm.pipeline_step,
    )


def _parse_dt(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso)
    except ValueError:
        return None

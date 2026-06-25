"""Build provider-independent internal requests."""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

from app.config import get_settings
from app.schemas.internal_request import (
    CostContext,
    ImagePreprocessConfig,
    InternalRequest,
    ModelSpec,
    RuntimeOptions,
    SampleRef,
    TemplateRefs,
)
from app.schemas.model_config import ModelConfig
from app.schemas.output_contract import OutputContract
from app.schemas.pricing import PricingProfile, PricingSnapshot
from app.schemas.prompt import PromptVersion, PromptVersionData
from app.schemas.sample_record import SampleRecord
from app.services.image_preprocess import preprocess_image
from app.services.prompt_renderer import render_prompt


def build_internal_request(
    sample: SampleRecord,
    prompt_version: PromptVersion | PromptVersionData,
    model_config: ModelConfig,
    output_contract: OutputContract,
    pricing: PricingProfile | PricingSnapshot,
    preprocess_config: ImagePreprocessConfig | None = None,
) -> InternalRequest:
    """Build an InternalRequest from saved configuration and one sample."""

    request_id = f"req_{uuid4().hex}"
    prompt = render_prompt(
        prompt_version.user_template,
        prompt_version.system_prompt,
        sample,
    )
    if isinstance(prompt_version, PromptVersion):
        prompt.template_refs = TemplateRefs(
            prompt_id=prompt_version.prompt_id,
            prompt_version_id=prompt_version.prompt_version_id,
        )

    preprocess = preprocess_config or ImagePreprocessConfig()
    cache_dir = _image_cache_dir()
    images = [
        preprocess_image(image, preprocess, cache_dir)
        for image in sorted(sample.images, key=lambda item: item.order)
    ]
    snapshot = _pricing_snapshot(pricing)

    return InternalRequest(
        request_id=request_id,
        sample_ref=SampleRef(sample_id=sample.sample_id, sample_set_id=sample.sample_set_id),
        prompt=prompt,
        images=images,
        model=ModelSpec(
            provider_id=model_config.provider_id,
            model_id=model_config.model_id,
            adapter_id=model_config.adapter_id,
            parameters=model_config.parameters,
            provider_options=model_config.provider_options.copy(),
        ),
        output_contract=output_contract,
        cost_context=CostContext(
            pricing_profile_id=snapshot.pricing_profile_id,
            currency=snapshot.currency,
            pricing_snapshot=snapshot,
        ),
        runtime=RuntimeOptions(),
    )


def _pricing_snapshot(pricing: PricingProfile | PricingSnapshot) -> PricingSnapshot:
    if isinstance(pricing, PricingSnapshot):
        return pricing
    return PricingSnapshot(
        pricing_profile_id=pricing.pricing_profile_id,
        currency=pricing.currency,
        input_token_price=pricing.input_token_price,
        output_token_price=pricing.output_token_price,
        cached_input_price=pricing.cached_input_price,
        batch_discount=pricing.batch_discount,
        image_pricing=pricing.image_pricing,
        raw=pricing.model_dump(mode="json"),
    )


def _image_cache_dir() -> Path:
    return get_settings().image_cache_dir

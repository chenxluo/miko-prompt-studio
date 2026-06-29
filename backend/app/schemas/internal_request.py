"""Internal Request – the provider-independent standard representation of a
single model request.

Mirrors section 2 of 文件格式文档.md.

Lifecycle::

    Sample Record
        + Prompt Spec
        + Model Config
        + Output Contract
        + Image Preprocess Config
        + Runtime Options
        = Internal Request
            → Provider Adapter
            → Platform API

The Internal Request contains *rendered* prompts (not templates) and
*resolved* images (after preprocessing), so that a Run Record can always
reproduce exactly what was sent.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.schemas.model_config import ModelParameters
from app.schemas.output_contract import OutputContract
from app.schemas.pricing import PricingSnapshot


class RenderContext(BaseModel):
    """Snapshot of the variables used when rendering the prompt template.

    Stored so that you can later trace which ``vars`` produced which text.
    """

    vars: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    sample_id: str | None = None


class TemplateRefs(BaseModel):
    """References to the original prompt version (the snapshot is kept separately)."""

    prompt_id: str | None = None
    prompt_version_id: str | None = None


class PromptSpec(BaseModel):
    """Rendered prompt section of an Internal Request."""

    system_prompt: str = ""
    user_prompt: str = ""
    render_context: RenderContext = Field(default_factory=RenderContext)
    template_refs: TemplateRefs = Field(default_factory=TemplateRefs)


class ImagePreprocessConfig(BaseModel):
    """Declarative image preprocessing strategy.

    Preprocessing is *explicit* — never hidden — because it directly
    affects image token cost, bbox coordinates, and output quality.
    """

    # original | resize_long_edge | resize_short_edge | fit_within_box
    # | center_crop | convert_format | limit_total_pixels
    mode: str = "original"
    long_edge: int | None = None
    short_edge: int | None = None
    box_width: int | None = None
    box_height: int | None = None
    format: str | None = None  # jpeg | png | webp
    quality: int | None = None  # 1-100 for jpeg/webp
    target_pixels: int | None = None


class ResolvedImage(BaseModel):
    """The actual image bytes/metadata that will be sent to the provider."""

    path: str | None = None
    uri: str | None = None  # data: URI (preferred for API calls)
    mime_type: str = "image/png"
    width: int | None = None
    height: int | None = None
    file_size: int | None = None
    sha256: str | None = None


class RequestImage(BaseModel):
    """An image entry inside an Internal Request.

    This is the preprocessed counterpart of an :class:`ImageRef`.  It
    records both the *strategy* (``preprocess``) and the *result*
    (``resolved``) for full reproducibility.
    """

    request_image_id: str
    source_image_id: str | None = None
    role: str = "target"
    path: str | None = None  # original path
    mime_type: str | None = None
    order: int = 0
    preprocess: ImagePreprocessConfig = Field(default_factory=ImagePreprocessConfig)
    resolved: ResolvedImage | None = None


class ModelSpec(BaseModel):
    """Model section of an Internal Request."""

    provider_id: str
    model_id: str
    adapter_id: str = "openai_compat"
    parameters: ModelParameters = Field(default_factory=ModelParameters)
    provider_options: dict[str, Any] = Field(default_factory=dict)


class CostContext(BaseModel):
    """Pricing context attached to a request."""

    pricing_profile_id: str | None = None
    currency: str = "USD"
    pricing_snapshot: PricingSnapshot | None = None


class RetryPolicy(BaseModel):
    max_retries: int = 1
    retry_on: list[str] = Field(
        default_factory=lambda: ["rate_limit", "timeout", "network_error"]
    )


class RuntimeOptions(BaseModel):
    timeout_seconds: int = 120
    retry_policy: RetryPolicy = Field(default_factory=RetryPolicy)
    dry_run: bool = False


class SampleRef(BaseModel):
    """Lightweight reference to the source sample."""

    sample_id: str
    sample_set_id: str | None = None


class InternalRequest(BaseModel):
    """The full, provider-independent request that will be sent to an adapter."""

    schema_version: str = "internal_request.v1"
    request_id: str
    sample_ref: SampleRef
    prompt: PromptSpec = Field(default_factory=PromptSpec)
    images: list[RequestImage] = Field(default_factory=list)
    model: ModelSpec
    output_contract: OutputContract = Field(default_factory=OutputContract)
    cost_context: CostContext = Field(default_factory=CostContext)
    runtime: RuntimeOptions = Field(default_factory=RuntimeOptions)

    # Convenience accessors --------------------------------------------------

    @property
    def system_prompt(self) -> str:
        return self.prompt.system_prompt

    @property
    def user_prompt(self) -> str:
        return self.prompt.user_prompt

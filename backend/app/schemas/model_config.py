"""Model Config – saved combinations of provider + model + parameters.

Mirrors section 8.3 of 设计文档.md.

The same provider/model can have multiple saved configs, e.g.:
  qwen-vl-max / precise-json
  qwen-vl-max / creative-caption
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.schemas.common import TimestampedModel


class ModelParameters(BaseModel):
    """Common model parameters.

    Not every provider supports every parameter.  The adapter is
    responsible for passing through what it can and ignoring (or warning
    on) the rest.
    """

    temperature: float | None = None
    max_output_tokens: int | None = None
    top_p: float | None = None
    seed: int | None = None
    stop: list[str] | None = None

    # Thinking / reasoning parameters (supported by some OpenAI-compatible APIs)
    enable_thinking: bool | None = None
    thinking_budget: int | None = None
    reasoning_effort: str | None = None  # "minimal" | "low" | "medium" | "high"

    # Streaming — UI placeholder, NOT yet sent to the provider API.
    stream: bool | None = None


class ModelConfig(TimestampedModel):
    """A named, saved set of model + parameters."""

    model_config_id: str
    name: str
    provider_id: str
    model_id: str
    adapter_id: str = "openai_compat"
    parameters: ModelParameters = Field(default_factory=ModelParameters)
    provider_options: dict[str, Any] = Field(default_factory=dict)
    notes: str = ""


class ModelConfigSnapshot(BaseModel):
    """Frozen copy of a model config stored in a Run Session/Item."""

    model_config_id: str | None = None
    provider_id: str
    model_id: str
    adapter_id: str
    parameters: ModelParameters = Field(default_factory=ModelParameters)
    provider_options: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Provider capability (section 5.3 of 文件格式文档)
# ---------------------------------------------------------------------------


class ProviderCapability(BaseModel):
    """Describes what a provider/model can do.

    The request builder checks this *before* dispatching to an adapter so
    that unsupported features produce a clear error instead of a silent
    degradation.
    """

    provider_id: str
    model_id: str
    supports_image: bool = False
    supports_multi_image: bool = False
    supports_system_prompt: bool = True
    supports_json_mode: bool = False
    supports_strict_json_schema: bool = False
    max_images: int | None = None
    max_output_tokens: int | None = None
    known_quirks: list[str] = Field(default_factory=list)
    notes: str = ""

    # URL image transport capability (shared contract) ----------------------
    # ``direct_image_uri_schemes`` are bare lowercase URI scheme names the
    # adapter can accept without the backend fetching the bytes
    # (e.g. Vertex ``gs``, OpenAI ``http``/``https`` via ``image_url.url``).
    direct_image_uri_schemes: list[str] = Field(default_factory=list)
    # Whether the adapter accepts inline base64 / file bytes in the provider
    # payload. When ``False``, ``url_image_transport`` must resolve to direct
    # for every remote URL or the run aborts with a non-retryable capability
    # error.
    supports_inline_image_data: bool = True
    # Maximum number of images that may be sent as direct URLs in a single
    # request. ``None`` ⇒ unlimited / not enforced.
    max_direct_images: int | None = None

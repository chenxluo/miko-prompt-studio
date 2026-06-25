"""Schema package – re-exports all Pydantic models for convenience."""

from app.schemas.common import (
    RETRYABLE_ERROR_TYPES,
    AttemptStatus,
    ErrorType,
    NormalizedError,
    OutputMode,
    ParseStatus,
    RunItemType,
    RunSessionStatus,
    RunType,
    TimestampedModel,
    utc_now,
)
from app.schemas.internal_request import (
    CostContext,
    ImagePreprocessConfig,
    InternalRequest,
    ModelSpec,
    PromptSpec,
    RenderContext,
    RequestImage,
    ResolvedImage,
    RetryPolicy,
    RuntimeOptions,
    SampleRef,
    TemplateRefs,
)
from app.schemas.model_config import (
    ModelConfig,
    ModelConfigSnapshot,
    ModelParameters,
    ProviderCapability,
)
from app.schemas.output_contract import OutputContract, ParserConfig
from app.schemas.pricing import (
    CostBreakdown,
    CostEstimate,
    ImagePriceMode,
    PricingProfile,
    PricingSnapshot,
)
from app.schemas.prompt import (
    Prompt,
    PromptSnapshot,
    PromptVersion,
    PromptVersionData,
    ImageSlotSpec,
    VariableSpec,
)
from app.schemas.run_record import (
    AdapterInfo,
    AdapterResult,
    Attempt,
    CompareAxes,
    ConfigSnapshot,
    NormalizedResponse,
    ParsedResponse,
    Review,
    RunItem,
    RunItemExportInfo,
    RunSession,
    RunSource,
    RunSummary,
    SafetyInfo,
    Usage,
)
from app.schemas.sample_record import (
    ImageMetadata,
    ImageRef,
    SampleRecord,
    SampleSet,
)

__all__ = [
    # common
    "AttemptStatus",
    "ErrorType",
    "NormalizedError",
    "OutputMode",
    "ParseStatus",
    "RETRYABLE_ERROR_TYPES",
    "RunItemType",
    "RunSessionStatus",
    "RunType",
    "TimestampedModel",
    "utc_now",
    # sample
    "ImageMetadata",
    "ImageRef",
    "SampleRecord",
    "SampleSet",
    # internal request
    "CostContext",
    "ImagePreprocessConfig",
    "InternalRequest",
    "ModelSpec",
    "PromptSpec",
    "RenderContext",
    "RequestImage",
    "ResolvedImage",
    "RetryPolicy",
    "RuntimeOptions",
    "SampleRef",
    "TemplateRefs",
    # output contract
    "OutputContract",
    "ParserConfig",
    # model config
    "ModelConfig",
    "ModelConfigSnapshot",
    "ModelParameters",
    "ProviderCapability",
    # pricing
    "CostBreakdown",
    "CostEstimate",
    "ImagePriceMode",
    "PricingProfile",
    "PricingSnapshot",
    # prompt
    "Prompt",
    "PromptSnapshot",
    "PromptVersion",
    "PromptVersionData",
    "ImageSlotSpec",
    "VariableSpec",
    # run record
    "AdapterInfo",
    "AdapterResult",
    "Attempt",
    "CompareAxes",
    "ConfigSnapshot",
    "NormalizedResponse",
    "ParsedResponse",
    "Review",
    "RunItem",
    "RunItemExportInfo",
    "RunSession",
    "RunSource",
    "RunSummary",
    "SafetyInfo",
    "Usage",
]

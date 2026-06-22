"""Task – saved Lab configuration templates."""

from __future__ import annotations

from pydantic import Field

from app.schemas.common import TimestampedModel
from app.schemas.model_config import ModelParameters
from app.schemas.output_contract import OutputContract


class Task(TimestampedModel):
    """A reusable Lab setup saved as a template."""

    task_id: str
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

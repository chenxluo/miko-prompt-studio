"""Task schemas: task headers plus immutable configuration versions."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.schemas.common import TimestampedModel
from app.schemas.model_config import ModelParameters
from app.schemas.output_contract import OutputContract
from app.schemas.prompt import ImageSlotSpec, VariableSpec


class TaskVersionData(BaseModel):
    system_prompt: str = ""
    user_template: str = ""
    provider_config_id: str | None = None
    model_id: str
    model_parameters: ModelParameters = Field(default_factory=ModelParameters)
    output_contract: OutputContract = Field(default_factory=OutputContract)
    image_preprocess_config: dict[str, Any] = Field(default_factory=dict)
    image_slot_specs: list[ImageSlotSpec] = Field(default_factory=list)
    variable_specs: list[VariableSpec] = Field(default_factory=list)
    pricing_profile_id: str | None = None
    notes: str = ""


class TaskVersion(TaskVersionData, TimestampedModel):
    task_version_id: str
    task_id: str
    version_label: str = "v1"
    parent_version_id: str | None = None


class TaskVersionSummary(BaseModel):
    task_version_id: str
    version_label: str
    provider_config_id: str | None = None
    model_id: str
    notes: str = ""
    created_at: str | None = None


class TaskInputImageSlot(BaseModel):
    slot_id: str
    role_hint: str | None = None
    label: str = ""
    required: bool = True
    min_count: int = 1
    max_count: int | None = 1
    description: str = ""


class TaskInputVariableSlot(BaseModel):
    var_id: str
    label: str = ""
    description: str = ""
    required: bool = True
    default_value: Any = ""
    type: str = "string"


class TaskInputExpectedColumn(BaseModel):
    column: str
    kind: str
    role_hint: str | None = None
    var_id: str | None = None
    required: bool = True


class TaskInputPromptSummary(BaseModel):
    system_prompt: str = ""
    user_template: str = ""


class TaskInputSpec(BaseModel):
    task_id: str
    task_version_id: str
    task_name: str
    version_label: str
    system_prompt: str = ""
    user_template: str = ""
    image_slots: list[TaskInputImageSlot] = Field(default_factory=list)
    variable_slots: list[TaskInputVariableSlot] = Field(default_factory=list)
    expected_csv_columns: list[TaskInputExpectedColumn] = Field(default_factory=list)
    csv_example_row: dict[str, str] = Field(default_factory=dict)
    jsonl_example: dict[str, Any] = Field(default_factory=dict)
    notes: str = ""


class Task(TimestampedModel):
    task_id: str
    name: str
    description: str = ""
    current_version_id: str | None = None
    tags: list[str] = Field(default_factory=list)
    current_version: TaskVersion | None = None
    versions: list[TaskVersion] | None = None


class TaskSnapshot(BaseModel):
    task_id: str | None = None
    task_version_id: str | None = None
    name: str = ""
    description: str = ""
    version_label: str | None = None
    provider_config_id: str | None = None
    model_id: str | None = None
    model_parameters: ModelParameters = Field(default_factory=ModelParameters)
    output_contract: OutputContract = Field(default_factory=OutputContract)
    image_preprocess_config: dict[str, Any] = Field(default_factory=dict)
    pricing_profile_id: str | None = None
    tags: list[str] = Field(default_factory=list)
    notes: str = ""

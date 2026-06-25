"""Prompt schemas.

Mirrors section 8.2 of 设计文档.md.

A Prompt is split into:
- system_prompt
- user_template  (may contain {{vars.x}} / {{sample.x}} / {{metadata.x}})
- notes

The prompt library stores editable snippets as a single flat object. Historical
run records still store PromptSnapshot values so old runs remain reproducible.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from app.schemas.common import TimestampedModel


class ImageSlotSpec(BaseModel):
    slot_id: str = ""
    label: str = ""
    description: str = ""
    role_hint: str | None = None
    required: bool = True
    min_count: int = 1
    max_count: int | None = 1


class VariableSpec(BaseModel):
    var_id: str = ""
    label: str = ""
    description: str = ""
    type: str = "string"
    required: bool = True
    default_value: str | None = ""


class PromptVersionData(BaseModel):
    """The editable content of a prompt version.

    This is what the user edits in the Lab.  When a run is executed, a
    *snapshot* of this data is saved into the Run Record so that history
    stays reproducible even if the prompt is later modified.
    """

    system_prompt: str = ""
    user_template: str = ""
    notes: str = ""


class PromptVersion(PromptVersionData, TimestampedModel):
    """Immutable version of a prompt."""

    prompt_version_id: str
    prompt_id: str


class Prompt(TimestampedModel):
    """A named editable prompt snippet."""

    prompt_id: str
    name: str
    system_prompt: str = ""
    user_template: str = ""
    notes: str = ""
    tags: list[str] = Field(default_factory=list)


class PromptSnapshot(BaseModel):
    """Frozen copy of a prompt version stored inside a Run Session/Item.

    This guarantees that re-running or inspecting a historical run always
    shows the exact prompt that was used, even if the live prompt is later
    edited or deleted.
    """

    prompt_id: str | None = None
    prompt_version_id: str | None = None
    system_prompt: str = ""
    user_template: str = ""
    notes: str = ""
    image_slot_specs: list[ImageSlotSpec] = Field(default_factory=list)
    variable_specs: list[VariableSpec] = Field(default_factory=list)
    version_label: str | None = None

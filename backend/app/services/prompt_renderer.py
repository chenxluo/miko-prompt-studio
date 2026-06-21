"""Simple prompt template rendering utilities."""

from __future__ import annotations

import json
import re
from typing import Any

from pydantic import BaseModel

from app.schemas.internal_request import PromptSpec, RenderContext, TemplateRefs
from app.schemas.sample_record import SampleRecord

_TOKEN_RE = re.compile(r"{{\s*([a-zA-Z_][\w]*(?:\.[^{}\s.]+)*)\s*}}")


def render_template(template: str, context: dict[str, Any]) -> str:
    """Render ``{{vars.x}}`` / ``{{sample.x}}`` / ``{{metadata.x}}`` tokens.

    Missing keys intentionally resolve to an empty string. No expressions,
    filters, loops, or external template engines are supported.
    """

    def replace(match: re.Match[str]) -> str:
        value = _resolve_path(context, match.group(1).split("."))
        return _stringify(value)

    return _TOKEN_RE.sub(replace, template or "")


def render_prompt(
    user_template: str,
    system_prompt: str,
    sample: SampleRecord,
    format_instruction: str = "",
) -> PromptSpec:
    """Render prompts for a sample and append output format instructions."""

    sample_dict = sample.model_dump(mode="json")
    context = {
        "vars": sample.vars,
        "sample": sample_dict,
        "metadata": sample.metadata,
    }
    rendered_user = render_template(user_template, context)
    rendered_system = render_template(system_prompt, context)
    instruction = (format_instruction or "").strip()
    if instruction:
        rendered_user = (
            f"{rendered_user.rstrip()}\n\n{instruction}" if rendered_user else instruction
        )

    return PromptSpec(
        system_prompt=rendered_system,
        user_prompt=rendered_user,
        render_context=RenderContext(
            vars=sample.vars.copy(),
            metadata=sample.metadata.copy(),
            sample_id=sample.sample_id,
        ),
        template_refs=TemplateRefs(),
        format_instruction=instruction,
    )


def _resolve_path(context: Any, parts: list[str]) -> Any:
    current = context
    for part in parts:
        if isinstance(current, BaseModel):
            current = getattr(current, part, "")
        elif isinstance(current, dict):
            current = current.get(part, "")
        elif isinstance(current, list) and part.isdigit():
            index = int(part)
            current = current[index] if 0 <= index < len(current) else ""
        else:
            current = getattr(current, part, "")
        if current == "" or current is None:
            return ""
    return current


def _stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bool | int | float):
        return str(value)
    return json.dumps(value, ensure_ascii=False)

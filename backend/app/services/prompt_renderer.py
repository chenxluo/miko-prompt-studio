"""Simple prompt template rendering utilities."""

from __future__ import annotations

import json
import re
from typing import Any

from pydantic import BaseModel

from app.schemas.internal_request import PromptSpec, RenderContext, TemplateRefs
from app.schemas.prompt import ImageSlotSpec, VariableSpec
from app.schemas.sample_record import ImageRef, SampleRecord

_TOKEN_RE = re.compile(r"{{\s*([a-zA-Z_][\w]*(?:\.[^{}\s.]+)*)\s*}}")
_CONDITIONAL_RE = re.compile(
    r"{{\s*([#^])\s*([a-zA-Z_][\w]*(?:\.[^{}\s.]+)*)\s*}}(.*?){{\s*/\s*\2\s*}}",
    re.DOTALL,
)
_IMAGE_TOKEN_RE = re.compile(r"{{\s*image\s*:\s*(\d+)\s*}}", re.IGNORECASE)
_EACH_TAG_RE = re.compile(
    r"{{\s*(?:#each\s+images\.([^{}\s.]+)|/each)\s*}}", re.IGNORECASE
)
_EACH_OPEN_RE = re.compile(r"{{\s*#each\s+images\.([^{}\s.]+)\s*}}", re.IGNORECASE)
_EACH_CLOSE_RE = re.compile(r"{{\s*/each\s*}}", re.IGNORECASE)
_EACH_LOCAL_RE = re.compile(r"{{\s*(number|image)\s*}}", re.IGNORECASE)


def split_prompt_image_parts(prompt: str, image_count: int) -> list[str | int]:
    """Split rendered prompt text into ordered text and image-index parts."""

    parts: list[str | int] = []
    referenced: set[int] = set()
    last_end = 0
    for match in _IMAGE_TOKEN_RE.finditer(prompt or ""):
        text = prompt[last_end : match.start()].strip()
        if text:
            parts.append(text)
        index = int(match.group(1))
        if index < image_count:
            parts.append(index)
            referenced.add(index)
        else:
            parts.append(f"[image {index} not available]")
        last_end = match.end()

    trailing = prompt[last_end:].strip()
    if trailing:
        parts.append(trailing)
    parts.extend(index for index in range(image_count) if index not in referenced)
    return parts


def extract_variable_specs(user_template: str, system_prompt: str = "") -> list[VariableSpec]:
    """Extract ``vars.*`` references from prompt templates.

    Variables referenced only inside conditional blocks are marked optional;
    variables with any unconditional ``{{vars.x}}`` reference are required.
    """

    templates = [system_prompt or "", user_template or ""]
    seen: dict[str, bool] = {}

    for template in templates:
        conditional_spans: list[tuple[int, int]] = []
        events: list[tuple[int, str, bool]] = []
        for match in _CONDITIONAL_RE.finditer(template):
            conditional_spans.append(match.span())
            events.append((match.start(), match.group(2), True))
            for token_match in _TOKEN_RE.finditer(match.group(3)):
                events.append(
                    (match.start(3) + token_match.start(), token_match.group(1), True)
                )

        for token_match in _TOKEN_RE.finditer(template):
            if _is_inside_span(token_match.start(), conditional_spans):
                continue
            events.append((token_match.start(), token_match.group(1), False))

        for _, path, in_conditional in sorted(events, key=lambda item: item[0]):
            _record_variable(path, seen, in_conditional=in_conditional)

    return [
        VariableSpec(
            var_id=var_id,
            label=var_id,
            description="",
            type="string",
            required=required,
            default_value="",
        )
        for var_id, required in seen.items()
    ]


def render_template(template: str, context: dict[str, Any]) -> str:
    """Render ``{{vars.x}}`` / ``{{sample.x}}`` / ``{{metadata.x}}`` tokens.

    Missing keys intentionally resolve to an empty string. No expressions,
    filters, loops, or external template engines are supported.
    """

    def replace(match: re.Match[str]) -> str:
        value = _resolve_path(context, match.group(1).split("."))
        return _stringify(value)

    return _TOKEN_RE.sub(replace, template or "")


def render_template_with_conditionals(template: str, context: dict[str, Any]) -> str:
    """Render prompt templates with simple truthy/falsy conditional blocks."""

    def replace_block(match: re.Match[str]) -> str:
        block_type = match.group(1)
        value = _resolve_path(context, match.group(2).split("."))
        should_render = bool(value)
        if block_type == "^":
            should_render = not should_render
        if not should_render:
            return ""
        return render_template_with_conditionals(match.group(3), context)

    rendered = template or ""
    previous = None
    while rendered != previous:
        previous = rendered
        rendered = _CONDITIONAL_RE.sub(replace_block, rendered)
    return render_template(rendered, context)


def expand_image_loops(
    template: str,
    sample: SampleRecord,
    image_slot_specs: list[ImageSlotSpec],
) -> str:
    """Expand the single supported image-slot loop into legacy image tokens."""

    tags = list(_EACH_TAG_RE.finditer(template or ""))
    if not tags:
        if "#each" in (template or "") or _EACH_CLOSE_RE.search(template or ""):
            raise ValueError(f"Sample '{sample.sample_id}': unmatched image each block.")
        return template or ""
    if (
        len(tags) != 2
        or not _EACH_OPEN_RE.fullmatch(tags[0].group())
        or not _EACH_CLOSE_RE.fullmatch(tags[1].group())
    ):
        reason = "nested" if len(tags) > 2 else "unmatched"
        raise ValueError(f"Sample '{sample.sample_id}': {reason} image each block.")

    slot_id = tags[0].group(1)
    specs = {spec.slot_id: spec for spec in image_slot_specs}
    if slot_id not in specs:
        raise ValueError(f"Sample '{sample.sample_id}': unknown image slot '{slot_id}'.")
    spec = specs[slot_id]
    role = spec.role_hint or spec.slot_id
    ordered = sorted(sample.images, key=lambda image: image.order)
    selected = [
        (index, image)
        for index, image in enumerate(ordered)
        if _image_slot_id(image) == slot_id
        or (_image_slot_id(image) is None and image.role == role)
    ]
    body = template[tags[0].end() : tags[1].start()]

    def render_item(number: int, absolute_index: int) -> str:
        return _EACH_LOCAL_RE.sub(
            lambda match: (
                str(number)
                if match.group(1).lower() == "number"
                else "{{image:" + str(absolute_index) + "}}"
            ),
            body,
        )

    return template[: tags[0].start()] + "".join(
        render_item(number, absolute_index)
        for number, (absolute_index, _) in enumerate(selected, start=1)
    ) + template[tags[1].end() :]


def _image_slot_id(image: ImageRef) -> str | None:
    return getattr(image, "slot_id", None)


def render_prompt(
    user_template: str,
    system_prompt: str,
    sample: SampleRecord,
    image_slot_specs: list[ImageSlotSpec] | None = None,
) -> PromptSpec:
    """Render prompts for a sample."""

    sample_dict = sample.model_dump(mode="json")
    context = {
        "vars": sample.vars,
        "sample": sample_dict,
        "metadata": sample.metadata,
    }
    if "#each" in (system_prompt or "") or _EACH_CLOSE_RE.search(system_prompt or ""):
        raise ValueError(
            f"Sample '{sample.sample_id}': image each blocks are only allowed in user_template."
        )
    rendered_user = render_template_with_conditionals(
        expand_image_loops(user_template, sample, image_slot_specs or []), context
    )
    rendered_system = render_template_with_conditionals(system_prompt, context)

    return PromptSpec(
        system_prompt=rendered_system,
        user_prompt=rendered_user,
        render_context=RenderContext(
            vars=sample.vars.copy(),
            metadata=sample.metadata.copy(),
            sample_id=sample.sample_id,
        ),
        template_refs=TemplateRefs(),
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


def _record_variable(path: str, seen: dict[str, bool], in_conditional: bool) -> None:
    parts = path.split(".")
    if len(parts) < 2 or parts[0] != "vars":
        return
    var_id = parts[-1]
    seen[var_id] = seen.get(var_id, False) or not in_conditional


def _is_inside_span(position: int, spans: list[tuple[int, int]]) -> bool:
    return any(start <= position < end for start, end in spans)


def _stringify(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bool | int | float):
        return str(value)
    return json.dumps(value, ensure_ascii=False)

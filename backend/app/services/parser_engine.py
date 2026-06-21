"""Model response parsing utilities."""

from __future__ import annotations

import json
import re
from typing import Any

from app.schemas.common import OutputMode, ParseStatus
from app.schemas.output_contract import OutputContract
from app.schemas.run_record import ParsedResponse

_JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.IGNORECASE | re.DOTALL)
_HEADING_RE = re.compile(r"^\s*(?:#{1,6}\s*)?([^:\n：]{1,80})\s*[:：]\s*(.*)$")


def parse_response(raw_text: str, contract: OutputContract) -> ParsedResponse:
    """Parse raw model text according to the output contract mode."""

    mode = contract.mode
    if mode == OutputMode.FREE_TEXT:
        return ParsedResponse(
            raw_text=raw_text,
            parsed=raw_text,
            parse_status=ParseStatus.NOT_PARSED,
        )
    if mode == OutputMode.SOFT_SECTIONS:
        return _parse_soft_sections(raw_text, contract)
    if mode == OutputMode.LOOSE_JSON:
        return _parse_json(raw_text, strict=False)
    if mode == OutputMode.STRICT_JSON:
        return _parse_json(raw_text, strict=True)
    if mode == OutputMode.CUSTOM and contract.parser:
        parser_type = contract.parser.type
        if parser_type in {"section_parser", "soft_sections"}:
            return _parse_soft_sections(raw_text, contract)
        if parser_type in {"json", "json_repair_parser", "strict_json_parser"}:
            return _parse_json(raw_text, strict=parser_type == "strict_json_parser")
    return ParsedResponse(raw_text=raw_text, parsed=raw_text, parse_status=ParseStatus.NOT_PARSED)


def _parse_soft_sections(raw_text: str, contract: OutputContract) -> ParsedResponse:
    sections: dict[str, str] = {}
    current: str | None = None
    buffer: list[str] = []

    def flush() -> None:
        nonlocal buffer, current
        if current is not None:
            sections[current] = "\n".join(buffer).strip()
        buffer = []

    lines = raw_text.splitlines()
    for index, line in enumerate(lines):
        next_line = lines[index + 1] if index + 1 < len(lines) else None
        heading = _match_section_heading(line, next_line)
        if heading:
            flush()
            current, inline = heading
            if inline:
                buffer.append(inline)
        elif current is not None:
            buffer.append(line)
    flush()

    errors: list[dict[str, Any]] = []
    expected = _expected_sections(contract)
    if expected:
        for name in expected:
            if name not in sections:
                errors.append({"type": "missing_section", "message": f"Missing section: {name}"})
        if sections:
            status = ParseStatus.PARSED if not errors else ParseStatus.PARTIALLY_PARSED
        else:
            status = ParseStatus.PARSE_FAILED
            errors.append({"type": "no_sections", "message": "No recognizable sections found."})
    elif sections:
        status = ParseStatus.PARSED
    else:
        status = ParseStatus.PARSE_FAILED
        errors.append({"type": "no_sections", "message": "No recognizable sections found."})

    return ParsedResponse(
        raw_text=raw_text,
        parsed=sections or None,
        parse_status=status,
        parse_errors=errors,
    )


def _match_section_heading(line: str, next_line: str | None) -> tuple[str, str] | None:
    match = _HEADING_RE.match(line)
    if match:
        return match.group(1).strip(" -*#\t"), match.group(2).strip()
    stripped = line.strip().strip("#* ")
    if (
        stripped
        and len(stripped) <= 40
        and next_line is not None
        and next_line.strip()
        and not stripped.endswith(("。", ".", ",", "，", ";", "；"))
    ):
        return stripped, ""
    return None


def _expected_sections(contract: OutputContract) -> list[str]:
    options = contract.parser.options if contract.parser else {}
    section_names = options.get("section_names", [])
    return [str(name) for name in section_names if str(name)]


def _parse_json(raw_text: str, strict: bool) -> ParsedResponse:
    errors: list[dict[str, Any]] = []
    for source, candidate in _json_candidates(raw_text):
        try:
            parsed = json.loads(candidate)
            status = ParseStatus.PARSED if source != "repaired" else ParseStatus.PARTIALLY_PARSED
            return ParsedResponse(
                raw_text=raw_text,
                parsed=parsed,
                parse_status=status,
                parse_errors=errors,
            )
        except json.JSONDecodeError as exc:
            errors.append({"type": f"invalid_json_{source}", "message": str(exc)})

    status = ParseStatus.PARSE_FAILED if strict else ParseStatus.PARTIALLY_PARSED
    return ParsedResponse(raw_text=raw_text, parsed=None, parse_status=status, parse_errors=errors)


def _json_candidates(raw_text: str) -> list[tuple[str, str]]:
    candidates = [("raw", raw_text.strip())]
    candidates.extend(
        ("code_block", match.group(1).strip())
        for match in _JSON_BLOCK_RE.finditer(raw_text)
    )
    start = raw_text.find("{")
    end = raw_text.rfind("}")
    if start != -1 and end > start:
        candidates.append(("repaired", raw_text[start : end + 1]))
    array_start = raw_text.find("[")
    array_end = raw_text.rfind("]")
    if array_start != -1 and array_end > array_start:
        candidates.append(("repaired", raw_text[array_start : array_end + 1]))
    return [(source, text) for source, text in candidates if text]

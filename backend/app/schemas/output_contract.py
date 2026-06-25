"""Output Contract – describes the expected shape of a model's response.

Mirrors section 2.6 of 文件格式文档.md.

Design principles:
- Structured output is an *optional capability*, not the default path.
- ``free_text`` and ``soft_sections`` are the recommended defaults.
- ``strict_json`` should only be used when the task truly requires it.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from app.schemas.common import OutputMode


class ParserConfig(BaseModel):
    """Declarative parser specification used by the parser engine."""

    type: str = "raw"
    options: dict[str, Any] = Field(default_factory=dict)


class OutputContract(BaseModel):
    """Contract between the user and the model about output format.

    The contract is *advisory* — the parser engine will try its best to
    interpret whatever the model returns, but the raw text is always
    preserved regardless of parse outcome.
    """

    mode: OutputMode = OutputMode.FREE_TEXT
    json_schema: dict[str, Any] | None = None
    parser: ParserConfig | None = None

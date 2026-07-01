"""Provider adapter package."""

from app.adapters.base import BaseAdapter
from app.adapters.openai_compat import OpenAICompatAdapter, OpenAINativeAdapter
from app.adapters.registry import (
    get_adapter,
    get_adapter_metadata,
    list_adapter_metadata,
    list_adapters,
    register_adapter,
)
from app.adapters.vertex import VertexAdapter

__all__ = [
    "BaseAdapter",
    "OpenAICompatAdapter",
    "OpenAINativeAdapter",
    "VertexAdapter",
    "get_adapter",
    "get_adapter_metadata",
    "list_adapter_metadata",
    "list_adapters",
    "register_adapter",
]

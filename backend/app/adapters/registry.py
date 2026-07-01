"""Provider adapter registry."""

from __future__ import annotations

from app.adapters.base import BaseAdapter
from app.adapters.openai_compat import OpenAICompatAdapter, OpenAINativeAdapter
from app.adapters.vertex import VertexAdapter

_REGISTRY: dict[str, type[BaseAdapter]] = {}

# Metadata for the /api/providers endpoint.
# Each entry describes the user-facing properties of an adapter.
_ADAPTER_METADATA: dict[str, dict[str, object]] = {
    "openai": {
        "adapter_id": "openai",
        "label": "OpenAI (Official)",
        "requires_base_url": False,
        "default_base_url": "https://api.openai.com/v1",
        "supports_model_discovery": True,
    },
    "openai_compat": {
        "adapter_id": "openai_compat",
        "label": "OpenAI-Compatible (Custom Endpoint)",
        "requires_base_url": True,
        "default_base_url": None,
        "supports_model_discovery": True,
    },
    "vertex": {
        "adapter_id": "vertex",
        "label": "Google Vertex AI (Gemini, JSON Key)",
        "requires_base_url": True,
        "default_base_url": "us-central1",
        "supports_model_discovery": True,
    },
}


def register_adapter(adapter_class: type[BaseAdapter]) -> None:
    """Register an adapter class by its ``adapter_id``."""

    adapter_id = getattr(adapter_class, "adapter_id", "")
    if not adapter_id:
        raise ValueError("Adapter class must define a non-empty adapter_id.")
    _REGISTRY[adapter_id] = adapter_class


def get_adapter(adapter_id: str) -> BaseAdapter:
    """Return a new adapter instance for ``adapter_id``."""

    try:
        adapter_class = _REGISTRY[adapter_id]
    except KeyError as exc:
        available = ", ".join(sorted(_REGISTRY)) or "none"
        raise KeyError(
            f"Adapter '{adapter_id}' is not registered. Available: {available}"
        ) from exc
    return adapter_class()


def list_adapters() -> list[str]:
    """Return registered adapter IDs."""

    return sorted(_REGISTRY)


def list_adapter_metadata() -> list[dict[str, object]]:
    """Return metadata for all registered adapters, sorted by adapter_id."""

    return [
        _ADAPTER_METADATA[aid]
        for aid in sorted(_ADAPTER_METADATA)
        if aid in _REGISTRY
    ]


def get_adapter_metadata(adapter_id: str) -> dict[str, object] | None:
    """Return metadata for a single adapter, or None if not found."""

    return _ADAPTER_METADATA.get(adapter_id)


# Register built-in adapters
register_adapter(OpenAINativeAdapter)
register_adapter(OpenAICompatAdapter)
register_adapter(VertexAdapter)

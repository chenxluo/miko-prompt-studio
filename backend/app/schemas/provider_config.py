"""Provider Config – a configured provider endpoint that bundles adapter,
base_url, and encrypted API key into one entity.

This replaces the old flow where provider_id, base_url, and api_key were
scattered across separate settings.  Now the user creates a ProviderConfig
once (e.g. "My DeepSeek", "OpenAI Official") and then simply selects it
in the Lab, picking a model from its catalog.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from app.schemas.common import TimestampedModel


class ProviderConfigData(BaseModel):
    """Editable fields of a provider config (excludes the encrypted key)."""

    name: str
    adapter_id: str = "openai"
    base_url: str | None = None
    notes: str = ""


class ProviderConfig(ProviderConfigData, TimestampedModel):
    """A fully configured provider endpoint.

    ``api_key_set`` indicates whether a key has been stored (the key itself
    is never sent to the frontend in plaintext).
    """

    provider_config_id: str
    api_key_set: bool = False
    api_key_masked: str = ""


class ProviderConfigWithKey(ProviderConfigData):
    """Payload for creating/updating a provider config with an API key."""

    provider_config_id: str | None = None  # None for create, set for update
    api_key: str | None = None  # None = keep existing key on update

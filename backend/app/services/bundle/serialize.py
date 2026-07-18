"""ORM ↔ bundle-entity converters and the entity registry."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import inspect

from app.models.model_config import ModelConfigORM
from app.models.pricing import PricingProfileORM
from app.models.prompt import PromptORM
from app.models.provider_config import ProviderConfigORM
from app.models.sample import SampleRecordORM, SampleSetORM
from app.models.task import TaskGroupORM, TaskORM, TaskVersionORM

from .schema import BundleEntity


@dataclass(frozen=True)
class EntitySpec:
    """Metadata describing how one ORM table maps to a bundle entity kind."""

    kind: str
    orm: type
    key_col: str
    payload_version: str
    name_col: str | None
    fk_cols: dict[str, str]
    secret_cols: tuple[str, ...]
    null_on_export: tuple[str, ...]


# Stable insertion order matters: parents are listed before children.
REGISTRY: dict[str, EntitySpec] = {
    "task_group": EntitySpec(
        kind="task_group",
        orm=TaskGroupORM,
        key_col="group_id",
        payload_version="task_group/1.0",
        name_col=None,
        fk_cols={},
        secret_cols=(),
        null_on_export=(),
    ),
    "provider_config": EntitySpec(
        kind="provider_config",
        orm=ProviderConfigORM,
        key_col="provider_config_id",
        payload_version="provider_config/1.0",
        name_col=None,
        fk_cols={},
        secret_cols=("api_key_encrypted",),
        null_on_export=("base_url", "models_cached_at"),
    ),
    "pricing_profile": EntitySpec(
        kind="pricing_profile",
        orm=PricingProfileORM,
        key_col="pricing_profile_id",
        payload_version="pricing_profile/1.0",
        name_col=None,
        fk_cols={"provider_config_id": "provider_config"},
        secret_cols=(),
        null_on_export=(),
    ),
    "model_config": EntitySpec(
        kind="model_config",
        orm=ModelConfigORM,
        key_col="model_config_id",
        payload_version="model_config/1.0",
        name_col=None,
        fk_cols={},
        secret_cols=(),
        null_on_export=(),
    ),
    "prompt": EntitySpec(
        kind="prompt",
        orm=PromptORM,
        key_col="prompt_id",
        payload_version="prompt/1.0",
        name_col=None,
        fk_cols={},
        secret_cols=(),
        null_on_export=(),
    ),
    "task": EntitySpec(
        kind="task",
        orm=TaskORM,
        key_col="task_id",
        payload_version="task/1.0",
        name_col="name",
        fk_cols={"group_id": "task_group"},
        secret_cols=(),
        null_on_export=(),
    ),
    "sample_set": EntitySpec(
        kind="sample_set",
        orm=SampleSetORM,
        key_col="sample_set_id",
        payload_version="sample_set/1.0",
        name_col="name",
        fk_cols={},
        secret_cols=(),
        null_on_export=(),
    ),
    "sample_record": EntitySpec(
        kind="sample_record",
        orm=SampleRecordORM,
        key_col="sample_id",
        payload_version="sample_record/1.0",
        name_col=None,
        fk_cols={"sample_set_id": "sample_set"},
        secret_cols=(),
        null_on_export=(),
    ),
    "task_version": EntitySpec(
        kind="task_version",
        orm=TaskVersionORM,
        key_col="task_version_id",
        payload_version="task_version/1.0",
        name_col=None,
        fk_cols={
            "task_id": "task",
            "provider_config_id": "provider_config",
            "pricing_profile_id": "pricing_profile",
            "parent_version_id": "task_version",
        },
        secret_cols=(),
        null_on_export=(),
    ),
}


def _to_json_value(value: Any) -> Any:
    """Convert an ORM attribute value into a JSON-safe bundle value."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, list | dict | str | int | float | bool):
        return value
    # Fallback for any unexpected scalar type.
    return value


def to_bundle_entity(orm_row: Any, spec: EntitySpec) -> BundleEntity:
    """Convert an ORM row into a :class:`BundleEntity`."""
    fields: dict[str, Any] = {}
    state = inspect(orm_row)
    for attr in state.attrs:
        key = attr.key
        if key == "id":
            continue
        if key in spec.secret_cols:
            continue
        value = attr.value
        value = None if key in spec.null_on_export else _to_json_value(value)
        fields[key] = value

    entity_id = getattr(orm_row, spec.key_col)
    return BundleEntity(
        kind=spec.kind,
        payload_version=spec.payload_version,
        id=entity_id,
        fields=fields,
    )


def from_bundle_entity(entity: BundleEntity, spec: EntitySpec) -> Any:
    """Construct an ORM instance from a :class:`BundleEntity`.

    The ``fields`` dict uses ORM attribute names (including ``metadata_`` for
    :class:`SampleSetORM`) and never contains the surrogate ``id`` key, so it
    can be passed directly to the ORM constructor.
    """
    return spec.orm(**entity.fields)

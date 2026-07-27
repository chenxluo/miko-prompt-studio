"""Regression: a variable image group (``max_count=None``) must survive the
full HTTP round-trip — list, detail, and re-save as a new version.

Root cause was that Task list/detail responses dump with ``exclude_none=True``,
which stripped ``max_count: null`` from nested ``image_slot_specs``. On reload
the frontend sent the spec back without ``max_count``; the Pydantic default
``max_count: int | None = 1`` then turned the unbounded group into a fixed
single-image slot.
"""
from fastapi.testclient import TestClient


def _provider(client: TestClient) -> str:
    response = client.post(
        "/api/provider-configs",
        json={"name": "var-group-provider", "adapter_id": "openai", "api_key": "sk-test"},
    )
    assert response.status_code == 200, response.text
    return response.json()["provider_config_id"]


def _version_with_variable_slot(provider_config_id: str) -> dict:
    return {
        "system_prompt": "sys",
        "user_template": "{{#each images.context}}\n{{number}}. {{image}}\n{{/each}}",
        "provider_config_id": provider_config_id,
        "model_id": "m",
        "model_parameters": {},
        "output_contract": {"mode": "free_text"},
        "image_preprocess_config": {"enabled": False},
        "image_slot_specs": [
            {
                "slot_id": "context",
                "role_hint": "context",
                "required": True,
                "min_count": 1,
                "max_count": None,  # variable / unbounded group
            }
        ],
        "variable_specs": [],
    }


def test_variable_image_group_round_trip(client: TestClient) -> None:
    provider_config_id = _provider(client)

    created = client.post(
        "/api/tasks",
        json={
            "name": "Variable Group Task",
            "version": _version_with_variable_slot(provider_config_id),
        },
    )
    assert created.status_code == 200, created.text
    task = created.json()
    assert task["current_version"]["image_slot_specs"][0]["max_count"] is None

    task_id = task["task_id"]

    # List endpoint must preserve max_count=None (this is the path loadTask reads).
    listed = client.get("/api/tasks").json()
    listed_task = next(item for item in listed if item["task_id"] == task_id)
    assert listed_task["current_version"]["image_slot_specs"][0]["max_count"] is None

    # Detail endpoint must preserve it too.
    detail = client.get(f"/api/tasks/{task_id}").json()
    assert detail["current_version"]["image_slot_specs"][0]["max_count"] is None

    # Re-saving the loaded spec as a new version must keep it unbounded. This
    # mirrors the lab "save as new task / new version" flow, which sends back
    # exactly what was loaded.
    loaded_specs = detail["current_version"]["image_slot_specs"]
    new_version_payload = _version_with_variable_slot(provider_config_id)
    new_version_payload["image_slot_specs"] = loaded_specs
    new_version = client.post(
        f"/api/tasks/{task_id}/versions",
        json=new_version_payload,
    )
    assert new_version.status_code == 200, new_version.text
    assert new_version.json()["image_slot_specs"][0]["max_count"] is None

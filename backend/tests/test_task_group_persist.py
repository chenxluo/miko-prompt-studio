
from fastapi.testclient import TestClient


def _provider(client: TestClient) -> str:
    response = client.post(
        "/api/provider-configs",
        json={"name": "Test", "provider": "openai", "api_key": "x", "base_url": "http://localhost"},
    )
    assert response.status_code == 200, response.text
    return response.json()["provider_config_id"]


def _version(provider_config_id: str) -> dict:
    return {
        "provider_config_id": provider_config_id,
        "model_id": "test-model",
        "system_prompt": "",
        "user_template": "Describe {{ prompt }}",
        "model_parameters": {"temperature": 0.1},
        "output_contract": {"mode": "free_text"},
        "image_preprocess_config": {"enabled": False},
        "notes": "initial",
    }


def test_update_task_group_id_is_persisted(client: TestClient) -> None:
    provider_config_id = _provider(client)

    # Create a group
    group_resp = client.post("/api/task-groups", json={"name": "My Group", "color": "#ff0000"})
    assert group_resp.status_code == 200, group_resp.text
    group_id = group_resp.json()["group_id"]

    # Create a task (no group)
    created = client.post(
        "/api/tasks",
        json={"name": "Task A", "version": _version(provider_config_id)},
    )
    assert created.status_code == 200, created.text
    task_id = created.json()["task_id"]

    detail0 = client.get(f"/api/tasks/{task_id}")
    assert detail0.status_code == 200, detail0.text
    assert detail0.json().get("group_id") is None

    # Move task into the group
    updated = client.put(
        f"/api/tasks/{task_id}",
        json={"group_id": group_id},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["group_id"] == group_id
    # Re-fetch task (simulates reload after restart)
    detail = client.get(f"/api/tasks/{task_id}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["group_id"] == group_id
    # Move task out of the group (ungroup)
    ungrouped = client.put(
        f"/api/tasks/{task_id}",
        json={"group_id": None},
    )
    assert ungrouped.status_code == 200, ungrouped.text
    assert ungrouped.json().get("group_id") is None
    detail2 = client.get(f"/api/tasks/{task_id}")
    assert detail2.status_code == 200, detail2.text
    assert detail2.json().get("group_id") is None

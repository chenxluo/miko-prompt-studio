import asyncio
import importlib

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("MIKO_DATA_DIR", str(tmp_path))

    import app.config as config
    import app.database as database

    config._settings = None
    database._engine = None
    database._session_factory = None

    import app.main as main

    main = importlib.reload(main)
    with TestClient(main.app) as test_client:
        yield test_client

    engine = database.get_engine()
    asyncio.run(engine.dispose())
    database._engine = None
    database._session_factory = None
    config._settings = None


def _provider(client: TestClient) -> str:
    response = client.post(
        "/api/provider-configs",
        json={"name": "test-provider", "adapter_id": "openai", "api_key": "sk-test"},
    )
    assert response.status_code == 200, response.text
    return response.json()["provider_config_id"]


def _prompt(client: TestClient, name: str = "prompt") -> dict:
    response = client.post(
        "/api/prompts",
        json={"name": name, "user_template": "Describe {{ prompt }}"},
    )
    assert response.status_code == 200, response.text
    return response.json()


def _version(prompt: dict, provider_config_id: str, model_id: str = "test-model") -> dict:
    return {
        "prompt_id": prompt["prompt_id"],
        "prompt_version_id": prompt["prompt_version_id"],
        "provider_config_id": provider_config_id,
        "model_id": model_id,
        "model_parameters": {"temperature": 0.1},
        "output_contract": {"mode": "free_text"},
        "image_preprocess_config": {"enabled": False},
        "notes": "initial",
    }


def test_create_list_get_update_version_and_delete_task(client: TestClient) -> None:
    provider_config_id = _provider(client)
    prompt = _prompt(client)

    created = client.post(
        "/api/tasks",
        json={
            "name": "Task A",
            "description": "desc",
            "tags": ["alpha"],
            "version": _version(prompt, provider_config_id),
        },
    )
    assert created.status_code == 200, created.text
    task = created.json()
    assert task["task_id"].startswith("task_")
    assert task["current_version"]["task_version_id"].startswith("tv_")
    assert task["current_version"]["version_label"] == "v1"

    listed = client.get("/api/tasks")
    assert listed.status_code == 200, listed.text
    assert listed.json()[0]["current_version"]["prompt_version_id"] == prompt["prompt_version_id"]

    second_prompt = _prompt(client, "prompt 2")
    new_version = client.post(
        f"/api/tasks/{task['task_id']}/versions",
        json=_version(second_prompt, provider_config_id, "test-model-2"),
    )
    assert new_version.status_code == 200, new_version.text
    assert new_version.json()["version_label"] == "v2"

    detail = client.get(f"/api/tasks/{task['task_id']}")
    assert detail.status_code == 200, detail.text
    assert [version["version_label"] for version in detail.json()["versions"]] == ["v1", "v2"]

    updated = client.put(
        f"/api/tasks/{task['task_id']}",
        json={"name": "Task B", "tags": ["beta"], "current_version_id": task["current_version_id"]},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["name"] == "Task B"
    assert updated.json()["current_version_id"] == task["current_version_id"]

    deleted = client.delete(f"/api/tasks/{task['task_id']}")
    assert deleted.status_code == 200, deleted.text
    assert client.get(f"/api/tasks/{task['task_id']}").status_code == 404

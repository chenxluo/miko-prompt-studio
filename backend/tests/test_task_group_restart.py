import asyncio
import importlib
import os

import pytest
from fastapi.testclient import TestClient


def _build_client(data_dir):
    os.environ["MIKO_DATA_DIR"] = str(data_dir)

    import app.config as config
    import app.database as database

    config._settings = None
    database._engine = None
    database._session_factory = None

    import app.main as main

    main = importlib.reload(main)
    return main.app, database


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


def _dispose(database):
    engine = database.get_engine()
    asyncio.run(engine.dispose())
    database._engine = None
    database._session_factory = None


def test_task_group_survives_client_restart(tmp_path) -> None:
    """Moving a task into a group must survive a backend restart."""
    data_dir = tmp_path

    # First client session: create group and task, move task into group
    app1, db1 = _build_client(data_dir)
    with TestClient(app1) as client1:
        provider_config_id = _provider(client1)

        group_resp = client1.post("/api/task-groups", json={"name": "My Group", "color": "#ff0000"})
        assert group_resp.status_code == 200, group_resp.text
        group_id = group_resp.json()["group_id"]

        created = client1.post(
            "/api/tasks",
            json={"name": "Task A", "version": _version(provider_config_id)},
        )
        assert created.status_code == 200, created.text
        task_id = created.json()["task_id"]

        updated = client1.put(f"/api/tasks/{task_id}", json={"group_id": group_id})
        assert updated.status_code == 200, updated.text
        assert updated.json()["group_id"] == group_id

    _dispose(db1)

    # Second client session: simulate restart / reopen
    app2, db2 = _build_client(data_dir)
    with TestClient(app2) as client2:
        detail = client2.get(f"/api/tasks/{task_id}")
        assert detail.status_code == 200, detail.text
        assert detail.json()["group_id"] == group_id

        listed = client2.get("/api/tasks")
        assert listed.status_code == 200, listed.text
        task = next((t for t in listed.json() if t["task_id"] == task_id), None)
        assert task is not None
        assert task["group_id"] == group_id

    _dispose(db2)

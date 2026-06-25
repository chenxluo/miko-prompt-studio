import asyncio
import importlib

import pytest
from fastapi.testclient import TestClient

from app.schemas.common import RunItemType, RunSessionStatus, RunType, utc_now


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


def _version(provider_config_id: str, model_id: str = "test-model") -> dict:
    return {
        "system_prompt": "",
        "user_template": "Describe {{ prompt }}",
        "provider_config_id": provider_config_id,
        "model_id": model_id,
        "model_parameters": {"temperature": 0.1},
        "output_contract": {"mode": "free_text"},
        "image_preprocess_config": {"enabled": False},
        "notes": "initial",
    }


def test_create_list_get_update_version_and_delete_task(client: TestClient) -> None:
    provider_config_id = _provider(client)

    created = client.post(
        "/api/tasks",
        json={
            "name": "Task A",
            "description": "desc",
            "tags": ["alpha"],
            "version": _version(provider_config_id),
        },
    )
    assert created.status_code == 200, created.text
    task = created.json()
    assert task["task_id"].startswith("task_")
    assert task["current_version"]["task_version_id"].startswith("tv_")
    assert task["current_version"]["version_label"] == "v1"

    listed = client.get("/api/tasks")
    assert listed.status_code == 200, listed.text
    assert listed.json()[0]["current_version"]["user_template"] == "Describe {{ prompt }}"

    new_version = client.post(
        f"/api/tasks/{task['task_id']}/versions",
        json=_version(provider_config_id, "test-model-2"),
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


def test_task_version_cost_stats_aggregates_completed_run_items(client: TestClient) -> None:
    provider_config_id = _provider(client)
    created = client.post(
        "/api/tasks",
        json={
            "name": "Cost Task",
            "description": "",
            "tags": [],
            "version": _version(provider_config_id),
        },
    )
    assert created.status_code == 200, created.text
    task = created.json()
    task_id = task["task_id"]
    version_id = task["current_version"]["task_version_id"]

    async def seed_runs() -> None:
        from app.database import get_session_factory
        from app.models.run import RunItemORM, RunSessionORM

        now = utc_now().isoformat()
        factory = get_session_factory()
        async with factory() as db:
            for run_index, costs in enumerate(([0.10, 0.20], [0.30])):
                run_id = f"run_cost_{run_index}"
                db.add(
                    RunSessionORM(
                        run_id=run_id,
                        run_type=RunType.BATCH.value,
                        name=f"Cost run {run_index}",
                        status=RunSessionStatus.COMPLETED.value,
                        started_at=now,
                        completed_at=now,
                        source={"task_id": task_id, "task_version_id": version_id},
                    )
                )
                for item_index, cost in enumerate(costs):
                    db.add(
                        RunItemORM(
                            run_item_id=f"ritem_cost_{run_index}_{item_index}",
                            run_id=run_id,
                            sample_id=f"sample_{item_index}",
                            status=RunItemType.SUCCEEDED.value,
                            completed_at=now,
                            estimated_cost=cost,
                            pricing_snapshot={"currency": "CNY"},
                        )
                    )
            db.add(
                RunSessionORM(
                    run_id="run_cost_running",
                    run_type=RunType.BATCH.value,
                    status=RunSessionStatus.RUNNING.value,
                    source={"task_id": task_id, "task_version_id": version_id},
                )
            )
            db.add(
                RunItemORM(
                    run_item_id="ritem_cost_ignored",
                    run_id="run_cost_running",
                    sample_id="sample_ignored",
                    status=RunItemType.SUCCEEDED.value,
                    estimated_cost=9.99,
                    pricing_snapshot={"currency": "USD"},
                )
            )
            await db.commit()

    asyncio.run(seed_runs())

    response = client.get(f"/api/tasks/{task_id}/versions/{version_id}/cost-stats")
    assert response.status_code == 200, response.text
    stats = response.json()
    assert stats["task_id"] == task_id
    assert stats["task_version_id"] == version_id
    assert stats["total_images"] == 3
    assert stats["total_cost"] == pytest.approx(0.60)
    assert stats["avg_cost_per_image"] == pytest.approx(0.20)
    assert stats["run_count"] == 2
    assert stats["sample_count"] == 2
    assert stats["currency"] == "CNY"
    assert stats["confidence"] == "low"

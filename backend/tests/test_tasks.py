import asyncio

import pytest
from fastapi.testclient import TestClient

from app.schemas.common import RunItemType, RunSessionStatus, RunType, utc_now


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
    # url_image_transport omitted at create must round-trip as the legacy
    # default value ``auto`` on the v1 row.
    assert task["current_version"]["url_image_transport"] == "auto"

    listed = client.get("/api/tasks")
    assert listed.status_code == 200, listed.text
    assert listed.json()[0]["current_version"]["user_template"] == "Describe {{ prompt }}"
    inline_version_payload = _version(provider_config_id, "test-model-2")
    inline_version_payload["url_image_transport"] = "inline"
    inline_version_payload["image_slot_specs"] = [
        {"slot_id": "slot_a", "role_hint": "target", "required": True},
    ]
    new_version = client.post(
        f"/api/tasks/{task['task_id']}/versions",
        json=inline_version_payload,
    )
    assert new_version.status_code == 200, new_version.text
    assert new_version.json()["version_label"] == "v2"

    # Explicit policy at version-create time must persist through GET.
    assert new_version.json()["url_image_transport"] == "inline"
    # Insert v3 (direct) so all three policies round-trip through the API.
    direct_payload = _version(provider_config_id, "test-model-direct")
    direct_payload["url_image_transport"] = "direct"
    direct_version_response = client.post(
        f"/api/tasks/{task['task_id']}/versions",
        json=direct_payload,
    )
    assert direct_version_response.status_code == 200, direct_version_response.text
    assert direct_version_response.json()["version_label"] == "v3"
    assert direct_version_response.json()["url_image_transport"] == "direct"

    detail = client.get(f"/api/tasks/{task['task_id']}")
    assert detail.status_code == 200, detail.text
    versions = detail.json()["versions"]
    assert [version["version_label"] for version in versions] == ["v1", "v2", "v3"]
    by_label = {version["version_label"]: version for version in versions}
    assert by_label["v1"]["url_image_transport"] == "auto"
    assert by_label["v2"]["url_image_transport"] == "inline"
    assert by_label["v3"]["url_image_transport"] == "direct"
    # Regression: image_slot_specs must survive GET /api/tasks/{id} serialization
    # (a missing field in _task_version_to_schema made the frontend MappingPanel vanish
    # for any task whose only inputs were image slots).
    assert [s["slot_id"] for s in by_label["v2"]["image_slot_specs"]] == ["slot_a"]

    # List endpoint exposes the same exact value through current_version.
    listed_task = next(item for item in listed.json() if item["task_id"] == task["task_id"])
    assert listed_task["current_version"]["url_image_transport"] == "auto"

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


def test_task_language_family_metadata_round_trip_and_clear(client: TestClient) -> None:
    provider_config_id = _provider(client)
    base = client.post(
        "/api/tasks",
        json={
            "name": "Caption ZH",
            "language": "zh-CN",
            "version": _version(provider_config_id),
        },
    ).json()

    translated = client.post(
        "/api/tasks",
        json={
            "name": "Caption EN",
            "family_id": base["task_id"],
            "language": "en-US",
            "translated_from_version_id": base["current_version_id"],
            "version": _version(provider_config_id),
        },
    )
    assert translated.status_code == 200, translated.text
    body = translated.json()
    assert body["family_id"] == base["task_id"]
    assert body["language"] == "en-US"
    assert body["translated_from_version_id"] == base["current_version_id"]
    reflected_base = client.get(f"/api/tasks/{base['task_id']}").json()
    assert reflected_base["family_id"] == base["task_id"]

    listed = client.get("/api/tasks").json()
    listed_translation = next(item for item in listed if item["task_id"] == body["task_id"])
    assert listed_translation["language"] == "en-US"

    cleared = client.put(
        f"/api/tasks/{body['task_id']}",
        json={"family_id": None, "language": None, "translated_from_version_id": None},
    )
    assert cleared.status_code == 200, cleared.text
    assert "family_id" not in cleared.json()
    assert "language" not in cleared.json()
    assert "translated_from_version_id" not in cleared.json()

    third = client.post(
        "/api/tasks",
        json={
            "name": "Caption JA",
            "language": "ja-JP",
            "version": _version(provider_config_id),
        },
    ).json()
    client.put(f"/api/tasks/{body['task_id']}", json={"family_id": base["task_id"]})
    merged = client.put(f"/api/tasks/{base['task_id']}", json={"family_id": third["task_id"]})
    assert merged.status_code == 200, merged.text
    assert client.get(f"/api/tasks/{body['task_id']}").json()["family_id"] == third["task_id"]

    detached_root = client.put(f"/api/tasks/{third['task_id']}", json={"family_id": None}).json()
    remaining_base = client.get(f"/api/tasks/{base['task_id']}").json()
    remaining_translation = client.get(f"/api/tasks/{body['task_id']}").json()
    assert "family_id" not in detached_root
    assert remaining_base["family_id"] == remaining_translation["family_id"]


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
                            usage={"image_count": 2},
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
            # A run that finished with some failures must still contribute its
            # succeeded items (regression: previously excluded entirely).
            db.add(
                RunSessionORM(
                    run_id="run_cost_partial",
                    run_type=RunType.BATCH.value,
                    status=RunSessionStatus.COMPLETED_WITH_ERRORS.value,
                    started_at=now,
                    completed_at=now,
                    source={"task_id": task_id, "task_version_id": version_id},
                )
            )
            db.add(
                RunItemORM(
                    run_item_id="ritem_cost_partial_ok",
                    run_id="run_cost_partial",
                    sample_id="sample_partial",
                    status=RunItemType.SUCCEEDED.value,
                    completed_at=now,
                    estimated_cost=0.40,
                    usage={"image_count": 2},
                    pricing_snapshot={"currency": "CNY"},
                )
            )
            db.add(
                RunItemORM(
                    run_item_id="ritem_cost_partial_fail",
                    run_id="run_cost_partial",
                    sample_id="sample_partial_fail",
                    status=RunItemType.FAILED.value,
                    completed_at=now,
                    estimated_cost=9.99,
                    pricing_snapshot={"currency": "CNY"},
                )
            )
            await db.commit()

    asyncio.run(seed_runs())

    response = client.get(f"/api/tasks/{task_id}/versions/{version_id}/cost-stats")
    assert response.status_code == 200, response.text
    stats = response.json()
    assert stats["task_id"] == task_id
    assert stats["task_version_id"] == version_id
    assert stats["total_images"] == 8
    assert stats["total_requests"] == 4
    assert stats["total_cost"] == pytest.approx(1.00)
    assert stats["avg_cost_per_image"] == pytest.approx(0.125)
    assert stats["avg_cost_per_request"] == pytest.approx(0.25)
    assert stats["run_count"] == 3
    assert stats["sample_count"] == 3
    assert stats["currency"] == "CNY"
    assert stats["confidence"] == "low"


def test_task_version_cost_stats_includes_compare_runs(client: TestClient) -> None:
    """A version exercised only via compare runs must still get a cost estimate.
    Compare items are attributed per-item via compare_axes.task_version_id, and
    only that version's items are counted (no leakage from sibling variants)."""
    provider_config_id = _provider(client)
    created = client.post(
        "/api/tasks",
        json={
            "name": "Compare Cost Task",
            "description": "",
            "tags": [],
            "version": _version(provider_config_id),
        },
    )
    task = created.json()
    task_id = task["task_id"]
    version_id = task["current_version"]["task_version_id"]
    # A sibling variant sharing the same compare run — its cost must NOT leak in.
    other_version_id = "tv_other_compare_variant"

    async def seed_compare() -> None:
        from app.database import get_session_factory
        from app.models.run import RunItemORM, RunSessionORM

        now = utc_now().isoformat()
        factory = get_session_factory()
        async with factory() as db:
            db.add(
                RunSessionORM(
                    run_id="run_cmp",
                    run_type=RunType.COMPARE.value,
                    name="Compare run",
                    status=RunSessionStatus.COMPLETED.value,
                    started_at=now,
                    completed_at=now,
                    source={
                        "mode": "compare",
                        "variants": [
                            {"label": "A", "task_version_id": version_id},
                            {"label": "B", "task_version_id": other_version_id},
                        ],
                    },
                )
            )
            # Belongs to the target version → counted.
            db.add(
                RunItemORM(
                    run_item_id="ritem_cmp_a",
                    run_id="run_cmp",
                    sample_id="s1",
                    status=RunItemType.SUCCEEDED.value,
                    completed_at=now,
                    estimated_cost=0.50,
                    usage={"image_count": 2},
                    pricing_snapshot={"currency": "CNY"},
                    compare_axes={"task_version_id": version_id, "config_label": "A"},
                )
            )
            # Belongs to the sibling variant → must be excluded.
            db.add(
                RunItemORM(
                    run_item_id="ritem_cmp_b",
                    run_id="run_cmp",
                    sample_id="s1",
                    status=RunItemType.SUCCEEDED.value,
                    completed_at=now,
                    estimated_cost=9.99,
                    usage={"image_count": 2},
                    pricing_snapshot={"currency": "CNY"},
                    compare_axes={"task_version_id": other_version_id, "config_label": "B"},
                )
            )
            await db.commit()

    asyncio.run(seed_compare())

    response = client.get(f"/api/tasks/{task_id}/versions/{version_id}/cost-stats")
    assert response.status_code == 200, response.text
    stats = response.json()
    assert stats["total_requests"] == 1
    assert stats["total_cost"] == pytest.approx(0.50)
    assert stats["total_images"] == 2
    assert stats["run_count"] == 1
    assert stats["currency"] == "CNY"
    assert stats["confidence"] == "low"

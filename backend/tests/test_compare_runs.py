import asyncio
import json
import time

from fastapi.testclient import TestClient

from app.schemas.common import AttemptStatus
from app.schemas.run_record import AdapterResult, NormalizedResponse, Usage


class FakeAdapter:
    async def execute(self, request, api_key: str, base_url: str | None = None, timeout: int = 120):
        return AdapterResult(
            status=AttemptStatus.SUCCEEDED,
            normalized_response=NormalizedResponse(text='{"ok": true}'),
            usage=Usage(input_tokens=10, output_tokens=4, total_tokens=14, image_count=0),
            latency_ms=2,
            provider_request_snapshot={"model": request.model.model_id},
            provider_response_raw={"ok": True},
        )


class SlowAdapter(FakeAdapter):
    async def execute(self, request, api_key: str, base_url: str | None = None, timeout: int = 120):
        await asyncio.sleep(0.2)
        return await super().execute(request, api_key, base_url, timeout)


def _patch_adapter(monkeypatch, adapter) -> None:
    import app.adapters.registry as registry
    import app.services.run_executor as run_executor

    monkeypatch.setattr(registry, "get_adapter", lambda adapter_id: adapter)
    monkeypatch.setattr(run_executor, "get_adapter", lambda adapter_id: adapter)


def _sample_set(client: TestClient) -> str:
    mapping = {
        "id_column": "id",
        "sample_type": "single_image",
        "var_columns": ["prompt"],
        "metadata_columns": [],
    }
    response = client.post(
        "/api/import/csv/file",
        files={"file": ("samples.csv", b"id,prompt\ns1,hello\ns2,world\n", "text/csv")},
        data={"delimiter": ",", "mapping": json.dumps(mapping)},
    )
    assert response.status_code == 200, response.text
    return response.json()["sample_set_id"]


def _provider(client: TestClient) -> str:
    provider = client.post(
        "/api/provider-configs",
        json={"name": "test-provider", "adapter_id": "openai", "api_key": "sk-test"},
    )
    assert provider.status_code == 200, provider.text
    return provider.json()["provider_config_id"]


def _task(client: TestClient, provider_config_id: str, name: str, model_id: str) -> str:
    task = client.post(
        "/api/tasks",
        json={
            "name": name,
            "version": {
                "system_prompt": "",
                "user_template": "Say {{ prompt }}",
                "provider_config_id": provider_config_id,
                "model_id": model_id,
                "model_parameters": {},
                "output_contract": {"mode": "free_text"},
            },
        },
    )
    assert task.status_code == 200, task.text
    return task.json()["task_id"]


def _compare_payload(sample_set_id: str, task_a: str, task_b: str) -> dict:
    return {
        "sample_set_id": sample_set_id,
        "variants": [
            {"task_id": task_a, "label": "A"},
            {"task_id": task_b, "label": "B"},
        ],
    }


def _setup_compare(client: TestClient) -> tuple[str, str, str]:
    sample_set_id = _sample_set(client)
    provider_config_id = _provider(client)
    task_a = _task(client, provider_config_id, "compare task A", "model-a")
    task_b = _task(client, provider_config_id, "compare task B", "model-b")
    return sample_set_id, task_a, task_b


def _wait_for_terminal_status(client: TestClient, run_id: str) -> dict:
    status = client.get(f"/api/compare-runs/{run_id}/status").json()
    deadline = time.time() + 5
    while status["session"]["status"] == "running" and time.time() < deadline:
        time.sleep(0.05)
        poll = client.get(f"/api/compare-runs/{run_id}/status")
        assert poll.status_code == 200, poll.text
        status = poll.json()
    return status


def test_compare_run_completes_with_axes_and_matrix(client: TestClient, monkeypatch) -> None:
    _patch_adapter(monkeypatch, FakeAdapter())
    sample_set_id, task_a, task_b = _setup_compare(client)

    response = client.post(
        "/api/compare-runs",
        json=_compare_payload(sample_set_id, task_a, task_b),
    )
    assert response.status_code == 200, response.text
    run_id = response.json()["session"]["run_id"]

    status = _wait_for_terminal_status(client, run_id)

    assert status["session"]["run_type"] == "compare"
    assert status["session"]["status"] == "completed"
    assert status["summary"]["total_items"] == 4
    assert len(status["items"]) == 4
    assert {item["status"] for item in status["items"]} == {"succeeded"}
    for item in status["items"]:
        axes = item["compare_axes"]
        assert axes["sample_id"] in {"s1", "s2"}
        assert axes["task_id"] in {task_a, task_b}
        assert axes["task_version_id"]
        assert axes["provider_config_id"]
        assert axes["model_id"] in {"model-a", "model-b"}
        assert axes["config_label"] in {"A", "B"}
    assert status["matrix"]["sample_ids"] == ["s1", "s2"]
    assert status["matrix"]["variant_labels"] == ["A", "B"]
    assert set(status["matrix"]["items_by_sample"]["s1"].keys()) == {"A", "B"}
    assert set(status["matrix"]["items_by_sample"]["s2"].keys()) == {"A", "B"}


def test_compare_cancel_works(client: TestClient, monkeypatch) -> None:
    _patch_adapter(monkeypatch, SlowAdapter())
    sample_set_id, task_a, task_b = _setup_compare(client)

    response = client.post(
        "/api/compare-runs",
        json=_compare_payload(sample_set_id, task_a, task_b),
    )
    assert response.status_code == 200, response.text
    run_id = response.json()["session"]["run_id"]

    cancel = client.post(f"/api/compare-runs/{run_id}/cancel")
    assert cancel.status_code == 200, cancel.text
    assert cancel.json()["cancel_requested"] is True

    status = _wait_for_terminal_status(client, run_id)
    assert status["session"]["status"] == "cancelled"
    assert status["summary"]["total_items"] == 4
    assert any(item["status"] == "cancelled" for item in status["items"])

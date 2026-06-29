import asyncio
import json
import time

import pytest
from fastapi.testclient import TestClient

from app.schemas.common import AttemptStatus, ErrorType, NormalizedError
from app.schemas.prompt import ImageSlotSpec
from app.schemas.run_record import AdapterResult, NormalizedResponse, Usage
from app.schemas.sample_record import ImageRef, SampleRecord
from app.services.batch_executor import map_sample_images_to_prompt_slots


class FakeAdapter:
    async def execute(self, request, api_key: str, base_url: str | None = None, timeout: int = 120):
        return AdapterResult(
            status=AttemptStatus.SUCCEEDED,
            normalized_response=NormalizedResponse(text='{"ok": true}'),
            usage=Usage(input_tokens=12, output_tokens=5, total_tokens=17, image_count=0),
            latency_ms=3,
            provider_request_snapshot={"model": request.model.model_id},
            provider_response_raw={"ok": True},
        )


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


def _sample_set_with(client: TestClient, count: int) -> str:
    mapping = {
        "id_column": "id",
        "sample_type": "single_image",
        "var_columns": ["prompt"],
        "metadata_columns": [],
    }
    rows = "".join(f"s{i},hello{i}\n" for i in range(count))
    response = client.post(
        "/api/import/csv/file",
        files={"file": ("samples.csv", f"id,prompt\n{rows}".encode(), "text/csv")},
        data={"delimiter": ",", "mapping": json.dumps(mapping)},
    )
    assert response.status_code == 200, response.text
    return response.json()["sample_set_id"]


def _task(client: TestClient, provider_config_id: str) -> str:
    task = client.post(
        "/api/tasks",
        json={
            "name": "batch task",
            "version": {
                "system_prompt": "",
                "user_template": "Say {{ prompt }}",
                "provider_config_id": provider_config_id,
                "model_id": "test-model",
                "model_parameters": {},
                "output_contract": {"mode": "free_text"},
            },
        },
    )
    assert task.status_code == 200, task.text
    return task.json()["task_id"]


def test_batch_run_completes_and_reports_summary(client: TestClient, monkeypatch) -> None:
    import app.adapters.registry as registry
    import app.services.run_executor as run_executor

    monkeypatch.setattr(registry, "get_adapter", lambda adapter_id: FakeAdapter())
    monkeypatch.setattr(run_executor, "get_adapter", lambda adapter_id: FakeAdapter())

    sample_set_id = _sample_set(client)
    provider = client.post(
        "/api/provider-configs",
        json={"name": "test-provider", "adapter_id": "openai", "api_key": "sk-test"},
    )
    assert provider.status_code == 200, provider.text
    task_id = _task(client, provider.json()["provider_config_id"])

    response = client.post(
        "/api/batch-runs",
        json={
            "task_id": task_id,
            "sample_set_id": sample_set_id,
        },
    )
    assert response.status_code == 200, response.text
    run_id = response.json()["session"]["run_id"]

    status = response.json()
    deadline = time.time() + 5
    while status["session"]["status"] == "running" and time.time() < deadline:
        time.sleep(0.05)
        poll = client.get(f"/api/batch-runs/{run_id}/status")
        assert poll.status_code == 200, poll.text
        status = poll.json()

    assert status["session"]["status"] == "completed"
    assert status["summary"]["total_items"] == 2
    assert status["summary"]["succeeded_items"] == 2
    assert status["summary"]["failed_items"] == 0
    assert len(status["items"]) == 2
    assert {item["status"] for item in status["items"]} == {"succeeded"}


def test_map_sample_images_to_prompt_slots_by_role() -> None:
    sample = SampleRecord(
        sample_id="s1",
        images=[
            ImageRef(image_id="extra", role="unused", uri="data:image/png;base64,aaa", order=0),
            ImageRef(image_id="mask", role="mask", uri="data:image/png;base64,bbb", order=1),
            ImageRef(image_id="target", role="target", uri="data:image/png;base64,ccc", order=2),
        ],
    )
    image_slot_specs = [
        ImageSlotSpec(slot_id="slot_target", role_hint="target", required=True),
        ImageSlotSpec(slot_id="slot_mask", role_hint="mask", required=True),
    ]

    mapped = map_sample_images_to_prompt_slots(sample, image_slot_specs)

    assert [image.image_id for image in sorted(mapped.images, key=lambda image: image.order)] == [
        "target",
        "mask",
        "extra",
    ]


def test_map_sample_images_to_prompt_slots_missing_required_fails() -> None:
    sample = SampleRecord(sample_id="s1", images=[])
    image_slot_specs = [ImageSlotSpec(slot_id="slot_target", role_hint="target", required=True)]

    with pytest.raises(ValueError, match="missing image"):
        map_sample_images_to_prompt_slots(sample, image_slot_specs)


def test_batch_run_retries_rate_limited_then_succeeds(client: TestClient, monkeypatch) -> None:
    import app.adapters.registry as registry
    import app.services.batch_executor as batch_executor
    import app.services.run_executor as run_executor

    # Make backoff effectively instant so the test does not wait seconds.
    monkeypatch.setattr(
        batch_executor,
        "_BACKOFF_BASE_SECONDS",
        {"rate_limit": 0.0, "timeout": 0.0, "network_error": 0.0},
    )
    monkeypatch.setattr(batch_executor, "_BACKOFF_JITTER_SECONDS", 0.0)

    fail_counts: dict[str, int] = {}

    class RateLimitThenSucceedAdapter:
        async def execute(self, request, api_key: str, base_url=None, timeout: int = 120):
            sample_id = request.sample_ref.sample_id
            fails = fail_counts.get(sample_id, 0)
            if fails < 1:
                fail_counts[sample_id] = fails + 1
                return AdapterResult(
                    status=AttemptStatus.RATE_LIMITED,
                    error=NormalizedError(
                        type=ErrorType.RATE_LIMIT, message="rate limited", retryable=True
                    ),
                    latency_ms=1,
                )
            return AdapterResult(
                status=AttemptStatus.SUCCEEDED,
                normalized_response=NormalizedResponse(text='{"ok": true}'),
                usage=Usage(input_tokens=12, output_tokens=5, total_tokens=17, image_count=0),
                latency_ms=2,
                provider_request_snapshot={"model": request.model.model_id},
                provider_response_raw={"ok": True},
            )

    adapter = RateLimitThenSucceedAdapter()
    monkeypatch.setattr(registry, "get_adapter", lambda adapter_id: adapter)
    monkeypatch.setattr(run_executor, "get_adapter", lambda adapter_id: adapter)

    sample_set_id = _sample_set(client)
    provider = client.post(
        "/api/provider-configs",
        json={"name": "test-provider", "adapter_id": "openai", "api_key": "sk-test"},
    )
    assert provider.status_code == 200, provider.text
    task_id = _task(client, provider.json()["provider_config_id"])

    response = client.post(
        "/api/batch-runs",
        json={
            "task_id": task_id,
            "sample_set_id": sample_set_id,
            "max_concurrency": 2,
            "max_retries": 2,
        },
    )
    assert response.status_code == 200, response.text
    run_id = response.json()["session"]["run_id"]

    status = response.json()
    deadline = time.time() + 10
    while status["session"]["status"] == "running" and time.time() < deadline:
        time.sleep(0.05)
        poll = client.get(f"/api/batch-runs/{run_id}/status")
        assert poll.status_code == 200, poll.text
        status = poll.json()

    assert status["session"]["status"] == "completed", status
    assert status["summary"]["succeeded_items"] == 2
    assert status["summary"]["failed_items"] == 0
    assert {item["status"] for item in status["items"]} == {"succeeded"}
    # Each sample failed once (rate limit) then succeeded on retry.
    assert fail_counts == {"s1": 1, "s2": 1}


def test_batch_run_runs_items_concurrently(client: TestClient, monkeypatch) -> None:
    import app.adapters.registry as registry
    import app.services.run_executor as run_executor

    state = {"in_flight": 0, "peak": 0}

    class ConcurrencyTrackingAdapter:
        async def execute(self, request, api_key: str, base_url=None, timeout: int = 120):
            state["in_flight"] += 1
            state["peak"] = max(state["peak"], state["in_flight"])
            try:
                await asyncio.sleep(0.05)  # widen the concurrency window
                return AdapterResult(
                    status=AttemptStatus.SUCCEEDED,
                    normalized_response=NormalizedResponse(text='{"ok": true}'),
                    usage=Usage(input_tokens=12, output_tokens=5, total_tokens=17, image_count=0),
                    latency_ms=10,
                    provider_request_snapshot={"model": request.model.model_id},
                    provider_response_raw={"ok": True},
                )
            finally:
                state["in_flight"] -= 1

    adapter = ConcurrencyTrackingAdapter()
    monkeypatch.setattr(registry, "get_adapter", lambda adapter_id: adapter)
    monkeypatch.setattr(run_executor, "get_adapter", lambda adapter_id: adapter)
    sample_set_id = _sample_set_with(client, 4)
    provider = client.post(
        "/api/provider-configs",
        json={"name": "test-provider", "adapter_id": "openai", "api_key": "sk-test"},
    )
    assert provider.status_code == 200, provider.text
    task_id = _task(client, provider.json()["provider_config_id"])

    response = client.post(
        "/api/batch-runs",
        json={
            "task_id": task_id,
            "sample_set_id": sample_set_id,
            "max_concurrency": 4,
        },
    )
    assert response.status_code == 200, response.text
    run_id = response.json()["session"]["run_id"]

    status = response.json()
    deadline = time.time() + 10
    while status["session"]["status"] == "running" and time.time() < deadline:
        time.sleep(0.05)
        poll = client.get(f"/api/batch-runs/{run_id}/status")
        assert poll.status_code == 200, poll.text
        status = poll.json()

    assert status["session"]["status"] == "completed", status
    # Sequential (concurrency=1) would peak at 1; concurrency=4 with 4 samples
    # must overlap, so peak >= 3 proves real parallelism.
    assert state["peak"] >= 3, state

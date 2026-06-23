import asyncio
import importlib
import json
import time

import pytest
from fastapi.testclient import TestClient

from app.schemas.common import AttemptStatus
from app.schemas.prompt import ImageSlotSpec, PromptVersion
from app.schemas.run_record import AdapterResult, NormalizedResponse, Usage
from app.schemas.sample_record import ImageRef, SampleRecord
from app.services.batch_executor import map_sample_images_to_prompt_slots


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


def _task(client: TestClient, provider_config_id: str) -> str:
    prompt = client.post(
        "/api/prompts",
        json={"name": "batch prompt", "user_template": "Say {{ prompt }}"},
    )
    assert prompt.status_code == 200, prompt.text
    prompt_data = prompt.json()
    task = client.post(
        "/api/tasks",
        json={
            "name": "batch task",
            "version": {
                "prompt_id": prompt_data["prompt_id"],
                "prompt_version_id": prompt_data["prompt_version_id"],
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
    prompt = PromptVersion(
        prompt_id="prompt_1",
        prompt_version_id="pv_1",
        image_slot_specs=[
            ImageSlotSpec(slot_id="slot_target", role_hint="target", required=True),
            ImageSlotSpec(slot_id="slot_mask", role_hint="mask", required=True),
        ],
    )

    mapped = map_sample_images_to_prompt_slots(sample, prompt)

    assert [image.image_id for image in sorted(mapped.images, key=lambda image: image.order)] == [
        "target",
        "mask",
        "extra",
    ]


def test_map_sample_images_to_prompt_slots_missing_required_fails() -> None:
    sample = SampleRecord(sample_id="s1", images=[])
    prompt = PromptVersion(
        prompt_id="prompt_1",
        prompt_version_id="pv_1",
        image_slot_specs=[ImageSlotSpec(slot_id="slot_target", role_hint="target", required=True)],
    )

    with pytest.raises(ValueError, match="missing image"):
        map_sample_images_to_prompt_slots(sample, prompt)

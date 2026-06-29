"""Tests for POST /api/lab/run.

Covers the v0.6.0 regression where image_resolution_* / run_name were dropped
from LabRunPayload even though the endpoint forwards them to LabRunRequest.
"""

from fastapi.testclient import TestClient

from app.schemas.common import AttemptStatus
from app.schemas.run_record import AdapterResult, NormalizedResponse, Usage


class FakeAdapter:
    async def execute(self, request, api_key: str, base_url: str | None = None, timeout: int = 120):
        return AdapterResult(
            status=AttemptStatus.SUCCEEDED,
            normalized_response=NormalizedResponse(text="ok"),
            usage=Usage(input_tokens=10, output_tokens=3, total_tokens=13, image_count=0),
            latency_ms=2,
            provider_request_snapshot={"model": request.model.model_id},
            provider_response_raw={"ok": True},
        )


def test_lab_run_accepts_run_name_and_image_resolution(client: TestClient, monkeypatch) -> None:
    """LabRunPayload must accept run_name / image_resolution_* — the endpoint
    forwards them to LabRunRequest. Dropping them raised AttributeError before
    the request reached the adapter (v0.6.0 regression)."""
    import app.adapters.registry as registry
    import app.services.run_executor as run_executor

    monkeypatch.setattr(registry, "get_adapter", lambda adapter_id: FakeAdapter())
    monkeypatch.setattr(run_executor, "get_adapter", lambda adapter_id: FakeAdapter())

    provider = client.post(
        "/api/provider-configs",
        json={"name": "lab-provider", "adapter_id": "openai", "api_key": "sk-test"},
    )
    assert provider.status_code == 200, provider.text

    response = client.post(
        "/api/lab/run",
        json={
            "sample": {"sample_id": "lab-1", "images": [], "vars": {}, "metadata": {}},
            "system_prompt": "you are helpful",
            "user_prompt": "hi",
            "provider_config_id": provider.json()["provider_config_id"],
            "model_id": "test-model",
            "parameters": {"stream": False},
            "run_name": "my lab run",
            "image_resolution_enabled": True,
            "image_resolution_target": 768,
        },
    )
    assert response.status_code == 200, response.text
    session = response.json()
    assert session["status"] == "completed"
    # run_name is forwarded to the RunSession; the regression dropped it and the
    # endpoint blew up reading payload.run_name before reaching the adapter.
    assert session["name"] == "my lab run"

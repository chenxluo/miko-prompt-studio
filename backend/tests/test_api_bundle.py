"""HTTP API tests for bundle export/import endpoints."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_export_then_import_via_http(client: TestClient) -> None:
    pc = client.post(
        "/api/provider-configs",
        json={"name": "p", "adapter_id": "openai", "api_key": "sk-secret"},
    ).json()["provider_config_id"]

    created = client.post(
        "/api/tasks",
        json={
            "name": "API Task",
            "version": {
                "system_prompt": "SP",
                "user_template": "UT {{x}}",
                "provider_config_id": pc,
                "model_id": "m",
                "model_parameters": {"temperature": 0.1},
                "output_contract": {"mode": "free_text"},
            },
        },
    ).json()
    task_id = created["task_id"]

    resp = client.post("/api/bundle/export", json={"task_ids": [task_id]})
    assert resp.status_code == 200
    assert "attachment" in resp.headers["content-disposition"]
    body = resp.content
    assert b"sk-secret" not in body
    assert b'"api_key_encrypted":' not in body

    files = {"file": ("task.mikobundle", body, "application/json")}
    imp = client.post("/api/bundle/import?mode=skip", files=files)
    assert imp.status_code == 200
    report = imp.json()
    assert any(i.startswith("task:") for i in report["skipped"])


def test_export_requires_scope(client: TestClient) -> None:
    resp = client.post("/api/bundle/export", json={})
    assert resp.status_code == 400


def test_import_dry_run(client: TestClient) -> None:
    pc = client.post(
        "/api/provider-configs",
        json={"name": "p", "adapter_id": "openai", "api_key": "sk-secret"},
    ).json()["provider_config_id"]

    created = client.post(
        "/api/tasks",
        json={
            "name": "Dry Run Task",
            "version": {
                "system_prompt": "SP",
                "user_template": "UT {{x}}",
                "provider_config_id": pc,
                "model_id": "m",
                "model_parameters": {"temperature": 0.1},
                "output_contract": {"mode": "free_text"},
            },
        },
    ).json()
    task_id = created["task_id"]

    resp = client.post("/api/bundle/export", json={"task_ids": [task_id]})
    assert resp.status_code == 200
    body = resp.content

    files = {"file": ("task.mikobundle", body, "application/json")}
    imp = client.post("/api/bundle/import?dry_run=true", files=files)
    assert imp.status_code == 200
    report = imp.json()
    assert "created" in report
    assert "updated" in report
    assert "skipped" in report


def test_secret_never_in_export_body(client: TestClient) -> None:
    client.post(
        "/api/provider-configs",
        json={"name": "secret-p", "adapter_id": "openai", "api_key": "sk-very-secret"},
    )

    resp = client.post("/api/bundle/export", json={"all": True})
    assert resp.status_code == 200
    body = resp.content
    assert b"sk-very-secret" not in body
    assert b'"api_key_encrypted":' not in body

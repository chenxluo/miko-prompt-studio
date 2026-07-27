"""Regression: SQLite "database is locked" errors during a batch run must be
treated as transient infrastructure errors — retried with backoff — instead
of being recorded as a permanent, non-retryable item failure.

Previously the matrix executor's generic ``except Exception`` routed DB-lock
errors straight to ``_mark_item_failed`` with ``retryable=False``, so a brief
write-lock stall under concurrency permanently failed the item (and the error
masqueraded as the item's business result).
"""
import json
import sqlite3
import time

from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

import app.services.matrix_executor as matrix_executor
import app.services.run_executor as run_executor
from app.schemas.common import AttemptStatus
from app.schemas.run_record import AdapterResult, NormalizedResponse, Usage


class _FakeAdapter:
    async def execute(self, request, api_key: str, base_url: str | None = None, timeout: int = 120):
        return AdapterResult(
            status=AttemptStatus.SUCCEEDED,
            normalized_response=NormalizedResponse(text='{"ok": true}'),
            usage=Usage(input_tokens=1, output_tokens=1, total_tokens=2, image_count=0),
            latency_ms=1,
            provider_request_snapshot={"model": request.model.model_id},
            provider_response_raw={"ok": True},
        )


def _provider(client: TestClient) -> str:
    resp = client.post(
        "/api/provider-configs",
        json={"name": "dblock-provider", "adapter_id": "openai", "api_key": "sk-test"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["provider_config_id"]


def _sample_set(client: TestClient) -> str:
    mapping = {
        "id_column": "id",
        "sample_type": "single_image",
        "var_columns": ["prompt"],
        "metadata_columns": [],
    }
    resp = client.post(
        "/api/import/csv/file",
        files={"file": ("samples.csv", b"id,prompt\ns1,hello\n", "text/csv")},
        data={"delimiter": ",", "mapping": json.dumps(mapping)},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["sample_set_id"]


def _task(client: TestClient, provider_config_id: str) -> str:
    resp = client.post(
        "/api/tasks",
        json={
            "name": "dblock task",
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
    assert resp.status_code == 200, resp.text
    return resp.json()["task_id"]


def _wait_terminal(client: TestClient, run_id: str, timeout: float = 10.0) -> dict:
    deadline = time.time() + timeout
    status = client.get(f"/api/batch-runs/{run_id}/status").json()
    while status["session"]["status"] == "running" and time.time() < deadline:
        time.sleep(0.05)
        status = client.get(f"/api/batch-runs/{run_id}/status").json()
    return status


def test_is_db_lock_error_matches_sqlite_lock_messages() -> None:
    assert matrix_executor._is_db_lock_error(
        OperationalError("UPDATE x", params={}, orig=sqlite3.OperationalError("database is locked"))
    )
    assert matrix_executor._is_db_lock_error(RuntimeError("SQLITE_BUSY: database is locked"))
    # Non-lock errors must NOT match.
    assert not matrix_executor._is_db_lock_error(KeyError("nope"))
    assert not matrix_executor._is_db_lock_error(ValueError("bad input"))


def test_db_lock_error_is_retried_then_marked_retryable(client: TestClient, monkeypatch) -> None:
    """A DB-lock error during cell execution is retried up to max_attempts,
    and the eventual failure is recorded as retryable (not a permanent fail)."""
    import app.adapters.registry as registry

    monkeypatch.setattr(registry, "get_adapter", lambda adapter_id: _FakeAdapter())
    monkeypatch.setattr(run_executor, "get_adapter", lambda adapter_id: _FakeAdapter())

    # Force _execute_one_cell to raise a DB-lock error every call, and count
    # how many times it is invoked so we can prove retry happened.
    call_count = {"n": 0}

    async def _raise_db_lock(db, spec, cell, item):
        call_count["n"] += 1
        raise OperationalError(
            "UPDATE run_items SET ...",
            params={},
            orig=sqlite3.OperationalError("database is locked"),
        )

    monkeypatch.setattr(matrix_executor, "_execute_one_cell", _raise_db_lock)

    # Short-circuit backoff so the test doesn't sleep.
    async def _no_backoff(attempt, error_type, cancel_event):
        return

    monkeypatch.setattr(matrix_executor, "_interruptible_backoff", _no_backoff)

    provider_config_id = _provider(client)
    sample_set_id = _sample_set(client)
    task_id = _task(client, provider_config_id)

    resp = client.post(
        "/api/batch-runs",
        json={"task_id": task_id, "sample_set_id": sample_set_id, "max_retries": 2},
    )
    assert resp.status_code == 200, resp.text
    run_id = resp.json()["session"]["run_id"]

    status = _wait_terminal(client, run_id)

    # max_retries=2 ⇒ max_attempts=3 ⇒ the cell is attempted 3 times then given up.
    assert call_count["n"] == 3, call_count
    assert status["session"]["status"] == "completed_with_errors"
    assert status["summary"]["failed_items"] == 1
    item = status["items"][0]
    assert item["status"] == "failed"
    assert item["error"]["retryable"] is True
    assert "database is locked" in item["error"]["message"]
    assert item["error"]["type"] == "unknown_error"

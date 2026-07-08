import asyncio
import csv
import io
import json

from fastapi.testclient import TestClient


async def _seed_runs() -> None:
    from app.database import get_session_factory
    from app.models.run import AttemptORM, RunItemORM, RunSessionORM

    session_factory = get_session_factory()
    async with session_factory() as db:
        db.add_all(
            [
                RunSessionORM(
                    run_id="run_lab_alpha",
                    run_type="lab",
                    name="Alpha Lab",
                    status="completed",
                    summary={"currency": "EUR", "total_items": 2},
                    created_at="2026-01-03T00:00:00",
                ),
                RunSessionORM(
                    run_id="run_batch_beta",
                    run_type="batch",
                    name="Beta Batch",
                    status="failed",
                    summary={"currency": "USD", "total_items": 1},
                    created_at="2026-01-02T00:00:00",
                ),
                RunSessionORM(
                    run_id="run_lab_gamma",
                    run_type="lab",
                    name="Gamma Lab",
                    status="running",
                    summary={"currency": "JPY", "total_items": 1},
                    created_at="2026-01-01T00:00:00",
                ),
            ]
        )
        db.add_all(
            [
                RunItemORM(
                    run_item_id="item_alpha_1",
                    run_id="run_lab_alpha",
                    sample_id="sample_1",
                    status="succeeded",
                    response={"raw_text": "hello", "parsed": {"answer": "world"}},
                    usage={"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
                    cost={"estimated_cost": 0.12},
                    review={"accepted": True, "rating": 4, "labels": ["good", "concise"]},
                    error=None,
                    provider_id="provider-a",
                    model_id="model-a",
                    estimated_cost=0.12,
                    latency_ms=123,
                    created_at="2026-01-03T00:01:00",
                ),
                RunItemORM(
                    run_item_id="item_alpha_2",
                    run_id="run_lab_alpha",
                    sample_id="sample_2",
                    status="failed",
                    response={"raw_text": "bad", "parsed": "bad"},
                    usage={"input_tokens": 3, "output_tokens": 2, "total_tokens": 5},
                    cost={"currency": "GBP"},
                    review={"accepted": False, "rating": 1, "labels": ["bad"]},
                    error={"message": "boom"},
                    provider_id="provider-b",
                    model_id="model-b",
                    estimated_cost=0.01,
                    latency_ms=9,
                    created_at="2026-01-03T00:02:00",
                ),
                RunItemORM(
                    run_item_id="item_beta_1",
                    run_id="run_batch_beta",
                    sample_id="sample_3",
                    status="failed",
                    response={},
                    usage={},
                    cost={},
                    review={},
                    error={"message": "batch failed"},
                    created_at="2026-01-02T00:01:00",
                ),
            ]
        )
        db.add_all(
            [
                AttemptORM(
                    attempt_id="attempt_alpha_1",
                    run_item_id="item_alpha_1",
                    status="succeeded",
                ),
                AttemptORM(
                    attempt_id="attempt_alpha_2",
                    run_item_id="item_alpha_2",
                    status="failed",
                ),
                AttemptORM(attempt_id="attempt_beta_1", run_item_id="item_beta_1", status="failed"),
            ]
        )
        await db.commit()


def _seed() -> None:
    asyncio.run(_seed_runs())


def test_listing_runs_with_filters_search_and_pagination(client: TestClient) -> None:
    _seed()

    response = client.get("/api/runs?run_type=lab&limit=1&offset=0")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["total"] == 2
    assert [run["run_id"] for run in data["runs"]] == ["run_lab_alpha"]
    assert set(data["runs"][0]) == {
        "run_id",
        "run_type",
        "name",
        "status",
        "started_at",
        "completed_at",
        "summary",
        "created_at",
        "pipeline_id",
        "pipeline_step",
    }

    response = client.get("/api/runs?status=failed")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["total"] == 1
    assert data["runs"][0]["run_id"] == "run_batch_beta"

    response = client.get("/api/runs?search=ALPHA")
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["total"] == 1
    assert data["runs"][0]["name"] == "Alpha Lab"


def test_deleting_a_run_removes_items_and_attempts(client: TestClient) -> None:
    _seed()

    response = client.delete("/api/runs/run_lab_alpha")
    assert response.status_code == 200, response.text
    assert response.json() == {"deleted": True}
    assert client.get("/api/runs/run_lab_alpha").status_code == 404

    listing = client.get("/api/runs")
    assert listing.status_code == 200, listing.text
    assert listing.json()["total"] == 2

    async def remaining_attempt_ids() -> list[str]:
        from sqlalchemy import select

        from app.database import get_session_factory
        from app.models.run import AttemptORM

        session_factory = get_session_factory()
        async with session_factory() as db:
            result = await db.execute(
                select(AttemptORM.attempt_id).order_by(AttemptORM.attempt_id)
            )
            return list(result.scalars().all())

    assert asyncio.run(remaining_attempt_ids()) == ["attempt_beta_1"]


def test_exporting_run_jsonl_and_csv(client: TestClient) -> None:
    _seed()

    jsonl_response = client.get("/api/runs/run_lab_alpha/export/jsonl")
    assert jsonl_response.status_code == 200, jsonl_response.text
    assert jsonl_response.headers["content-type"].startswith("text/plain")
    assert jsonl_response.headers["content-disposition"] == (
        'attachment; filename="run_run_lab_alpha.jsonl"'
    )
    lines = [json.loads(line) for line in jsonl_response.text.splitlines()]
    assert len(lines) == 2
    assert lines[0]["run_id"] == "run_lab_alpha"
    assert lines[0]["run_item_id"] == "item_alpha_1"
    assert lines[0]["response"] == {"raw_text": "hello", "parsed": {"answer": "world"}}
    assert lines[0]["usage"] == {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}
    assert lines[1]["error"] == {"message": "boom"}

    csv_response = client.get("/api/runs/run_lab_alpha/export/csv")
    assert csv_response.status_code == 200, csv_response.text
    assert csv_response.headers["content-type"].startswith("text/csv")
    assert csv_response.headers["content-disposition"] == (
        'attachment; filename="run_run_lab_alpha.csv"'
    )
    rows = list(csv.DictReader(io.StringIO(csv_response.text)))
    assert len(rows) == 2
    assert rows[0]["run_item_id"] == "item_alpha_1"
    assert rows[0]["input_tokens"] == "10"
    assert rows[0]["estimated_cost"] == "0.12"
    assert rows[0]["currency"] == "EUR"
    assert rows[0]["raw_text"] == "hello"
    assert rows[0]["parsed_text"] == '{"answer": "world"}'
    assert rows[0]["accepted"] == "True"
    assert rows[0]["rating"] == "4"
    assert rows[0]["labels"] == "good,concise"
    assert rows[1]["currency"] == "GBP"
    assert rows[1]["error_message"] == "boom"

    assert client.get("/api/runs/missing/export/jsonl").status_code == 404
    assert client.get("/api/runs/missing/export/csv").status_code == 404


def test_exporting_run_html(client: TestClient) -> None:
    _seed()

    response = client.get("/api/runs/run_lab_alpha/export/html")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/html")
    assert response.headers["content-disposition"] == (
        'attachment; filename="run_run_lab_alpha.html"'
    )
    body = response.text
    assert "<!DOCTYPE html>" in body
    assert 'id="run-data"' in body  # embedded JSON payload
    assert 'class="card"' in body  # server-rendered card grid
    assert "Alpha Lab" in body  # run name in the header
    assert "item_alpha_1" in body  # run item id carried into the payload
    assert "hello" in body  # response raw_text present

    assert client.get("/api/runs/missing/export/html").status_code == 404


def test_html_export_neutralises_script_close_tag() -> None:
    """The embedded JSON payload must not be able to break out of its <script>."""
    from app.services.html_export import render_run_html

    session = {"run_id": "r1", "name": "T", "run_type": "lab", "summary": {}}
    items = [
        {
            "run_item_id": "i1",
            "sample_id": "s1",
            "status": "succeeded",
            "internal_request_snapshot": {},
            "response": {"raw_text": "x </script><script>alert(1)</script> y"},
            "usage": {},
            "cost": {},
            "review": {},
        }
    ]
    html_doc = render_run_html(session, items)
    # The guard rewrites "</" → "<\/" in the JSON blob, so a payload value
    # containing </script> cannot close the embedding <script> element early.
    assert "x </script>" not in html_doc
    assert "alert(1)" in html_doc  # value still present, just neutralised


def test_html_export_inlines_local_image_as_data_uri(tmp_path) -> None:
    import base64

    from app.services.html_export import _image_to_src

    png = tmp_path / "t.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
    src = _image_to_src({"path": str(png), "resolved": {"mime_type": "image/png"}})
    assert src is not None
    assert src.startswith("data:image/png;base64,")
    decoded = base64.b64decode(src.split(",", 1)[1])
    assert decoded.startswith(b"\x89PNG")


def test_html_export_image_fallbacks() -> None:
    from app.services.html_export import _image_to_src

    assert _image_to_src({"path": "/nonexistent/x.png"}) is None  # missing file
    assert _image_to_src({}) is None  # nothing to resolve
    # Remote URL is kept as-is, never fetched at export time.
    assert _image_to_src({"uri": "https://example.com/a.png"}) == "https://example.com/a.png"
